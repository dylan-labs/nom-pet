import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { JournalDailyMetadata, JournalEntry, NomSettings, SoulPreset, Weekday } from '../../shared/types';
import { generateJournalEntry } from './llm';
import { renderTemplateJournal } from './journal-template';
import { localIsoString, readMood } from './pet-mind';
import { Store } from './store';

const DIR = path.join(os.homedir(), '.nom', 'journal');

/**
 * Cumulative thresholds that read as "I crossed a milestone yesterday".
 * Spaced logarithmically so most active users hit one every few weeks
 * (rather than never, which is what the level-table thresholds would do).
 */
const CUMULATIVE_MILESTONES = [
  1_000, 10_000, 100_000, 500_000,
  1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000,
  500_000_000, 1_000_000_000, 10_000_000_000,
];

const WEEKDAYS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function dateFromKey(key: string): Date | null {
  // YYYY-MM-DD → Date at local midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  return new Date(y, mo - 1, d);
}

function weekdayOf(key: string): Weekday {
  const d = dateFromKey(key);
  if (!d) return 'Mon';
  const isoDay = d.getDay() || 7; // Sun=0→7
  return WEEKDAYS[isoDay - 1]!;
}

function dateLabel(key: string): string {
  const d = dateFromKey(key);
  if (!d) return key;
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
}

function journalPath(dateKey: string): string {
  return path.join(DIR, `${dateKey}.md`);
}

/**
 * Serialize a JournalEntry to the on-disk markdown form. Frontmatter is
 * deliberately YAML-ish but hand-written (no yaml dep): the values we
 * emit are all simple scalars / inline arrays.
 */
function serialize(entry: JournalEntry): string {
  const milestones = entry.metadata.milestonesCrossed.length > 0
    ? `[${entry.metadata.milestonesCrossed.join(', ')}]`
    : '[]';
  const preset = entry.soulKernelPreset ?? '';
  return `---
date: ${entry.date}
weekday: ${entry.weekday}
weather: ${entry.weather}
tokens: ${entry.metadata.yesterdayTokens}
dayBeforeTokens: ${entry.metadata.dayBeforeTokens}
weekAvgTokens: ${entry.metadata.weekAvgTokens}
milestonesCrossed: ${milestones}
generatedBy: ${entry.generatedBy}
petName: ${entry.petName}
soulKernelPreset: ${preset}
generatedAt: ${entry.generatedAt}
---

${entry.body}
`;
}

/** Pull a single scalar out of the YAML-ish frontmatter we wrote. */
function readScalar(fm: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = re.exec(fm);
  return m ? m[1]!.trim() : null;
}

function parseFrontmatter(text: string): { fm: string; body: string } | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  return { fm: text.slice(4, end), body: text.slice(end + 5).trimEnd() };
}

/** All milestone thresholds T such that prevCum < T ≤ newCum. */
function milestonesBetween(prevCum: number, newCum: number): number[] {
  if (newCum <= prevCum) return [];
  return CUMULATIVE_MILESTONES.filter((t) => t > prevCum && t <= newCum);
}

/**
 * Build the structured metadata that both the LLM and the template
 * fallback consume. Today's live tokens are subtracted from cumulative
 * to estimate where things stood at end-of-yesterday — close enough for
 * milestone detection (off by at most a few seconds of live counting on
 * the journal-trigger morning).
 */
function buildMetadata(store: Store): JournalDailyMetadata | null {
  const report = store.computeDailyReport();
  if (!report) return null;
  const snap = store.snapshot();
  const cumEndOfYesterday = Math.max(0, snap.cumulative - snap.today);
  const cumStartOfYesterday = Math.max(0, cumEndOfYesterday - report.yesterdayTokens);
  return {
    dateKey: report.yesterdayKey,
    weekday: weekdayOf(report.yesterdayKey),
    yesterdayTokens: report.yesterdayTokens,
    dayBeforeTokens: report.dayBeforeTokens,
    weekAvgTokens: report.weekAvgTokens,
    milestonesCrossed: milestonesBetween(cumStartOfYesterday, cumEndOfYesterday),
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/** List YYYY-MM-DD dates that have a journal on disk, newest first. */
export async function listJournalDates(): Promise<string[]> {
  ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .map((n) => n.slice(0, -3))
    .sort((a, b) => b.localeCompare(a));
}

export async function readJournal(dateKey: string): Promise<JournalEntry | null> {
  let text: string;
  try {
    text = await fs.readFile(journalPath(dateKey), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const { fm, body } = parsed;

  const preset = readScalar(fm, 'soulKernelPreset');
  const generatedBy = readScalar(fm, 'generatedBy');
  const milestonesRaw = readScalar(fm, 'milestonesCrossed') ?? '[]';
  const milestonesCrossed: number[] = (() => {
    const inner = milestonesRaw.replace(/^\[|\]$/g, '').trim();
    if (!inner) return [];
    return inner.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  })();

  return {
    date: readScalar(fm, 'date') ?? dateKey,
    weekday: (readScalar(fm, 'weekday') as Weekday) ?? weekdayOf(dateKey),
    weather: readScalar(fm, 'weather') ?? '☁',
    body: body.trim(),
    generatedBy: generatedBy === 'llm' ? 'llm' : 'template',
    petName: readScalar(fm, 'petName') ?? 'nom',
    soulKernelPreset: preset && preset.length > 0 ? (preset as SoulPreset) : null,
    generatedAt: readScalar(fm, 'generatedAt') ?? localIsoString(),
    metadata: {
      dateKey,
      weekday: weekdayOf(dateKey),
      yesterdayTokens: Number(readScalar(fm, 'tokens') ?? 0),
      dayBeforeTokens: Number(readScalar(fm, 'dayBeforeTokens') ?? 0),
      weekAvgTokens: Number(readScalar(fm, 'weekAvgTokens') ?? 0),
      milestonesCrossed,
    },
  };
}

async function writeJournal(entry: JournalEntry): Promise<void> {
  ensureDir();
  const tmp = `${journalPath(entry.date)}.tmp`;
  await fs.writeFile(tmp, serialize(entry), 'utf8');
  await fs.rename(tmp, journalPath(entry.date));
}

async function exists(dateKey: string): Promise<boolean> {
  try {
    await fs.access(journalPath(dateKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Compose one journal entry from scratch: gather metadata, try the LLM
 * if it's enabled, fall back to templates otherwise. Always returns a
 * valid entry — the template path can never fail — so callers can
 * persist the result unconditionally.
 */
async function composeEntry(
  store: Store,
  settings: NomSettings,
  meta: JournalDailyMetadata,
): Promise<JournalEntry> {
  const label = dateLabel(meta.dateKey);
  let body: string | null = null;
  let weather: string | null = null;
  let generatedBy: 'llm' | 'template' = 'template';

  if (settings.llm?.enabled) {
    // Thread the pet's current mood through so journal voice picks up
    // today's emotional tint. Mood-aware journals are the same prose
    // as before but coloured by whatever the pet's been feeling — a
    // cranky day reads grumpier, a withdrawn day shorter and quieter.
    const moodState = settings.autonomy.enabled ? await readMood() : null;
    const result = await generateJournalEntry(
      settings.llm,
      settings.petName,
      settings.soulKernel,
      meta,
      label,
      moodState?.current,
    );
    if (result) {
      body = result.body;
      weather = result.weather;
      generatedBy = 'llm';
    }
  }

  if (!body) {
    const rendered = renderTemplateJournal(meta, settings.petName);
    body = rendered.body;
    weather = rendered.weather;
    generatedBy = 'template';
  }

  return {
    date: meta.dateKey,
    weekday: meta.weekday,
    weather: weather ?? '☁',
    body,
    generatedBy,
    petName: settings.petName,
    soulKernelPreset: settings.soulKernel?.preset ?? null,
    generatedAt: localIsoString(),
    metadata: meta,
  };
}

/**
 * Background entrypoint fired ~5s after launch. Bails early when:
 *   - yesterday's file already exists (most common case after day 1)
 *   - we have no data for yesterday (user wasn't active / brand-new install)
 * Otherwise composes one entry and writes it. Catches every error so a
 * bad LLM endpoint can never crash the main process.
 */
export async function generateJournalForYesterday(store: Store): Promise<JournalEntry | null> {
  try {
    const meta = buildMetadata(store);
    if (!meta) return null;
    if (await exists(meta.dateKey)) return null;
    const settings = store.getSettings();
    const entry = await composeEntry(store, settings, meta);
    await writeJournal(entry);
    console.log(`[nom][journal] wrote ${meta.dateKey} (${entry.generatedBy}, ${entry.body.length}ch)`);
    return entry;
  } catch (err) {
    console.error('[nom][journal] generate failed:', err);
    return null;
  }
}

/**
 * Force a fresh generation for a specific date, overwriting any existing
 * file. Used by the viewer's "重写今天" debug button (Phase 3) and the
 * IPC `regenerate` handler.
 */
export async function regenerateJournal(store: Store, dateKey: string): Promise<JournalEntry | null> {
  try {
    const meta = buildMetadata(store);
    // If the date isn't yesterday we can't reconstruct its metadata from
    // current state — yesterdayTokens etc. only apply to the most recent
    // closed day. For now, only regenerate "yesterday".
    if (!meta || meta.dateKey !== dateKey) return null;
    const settings = store.getSettings();
    const entry = await composeEntry(store, settings, meta);
    await writeJournal(entry);
    return entry;
  } catch (err) {
    console.error('[nom][journal] regenerate failed:', err);
    return null;
  }
}
