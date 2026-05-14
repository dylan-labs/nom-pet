import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AbsenceRecord, LastTickRecord, Mood, MoodState, PetMindNote } from '../../shared/types';

/**
 * The pet's private notebook. Lives at `~/.nom/pet-mind/` — users CAN
 * read it (this is intentional, per the spec's privacy-by-transparency
 * stance), but the directory is treated as the pet's own internal state,
 * not as user-facing journal content.
 *
 * Four files:
 *   - notes.jsonl    : append-only stream of observations / opinions /
 *                       self-reflections / dreams the pet writes about
 *                       the user and itself
 *   - mood.json      : current mood + drift history
 *   - absences.json  : when did the user last show up, what's the
 *                       longest gap ever observed
 *   - last-tick.json : timestamp + decision of the most recent tick
 *                       — surfaced by the Settings "透明度" widget
 *
 * All IO is async with try/catch fallbacks. A corrupt or missing file
 * never crashes the tick — we just fall back to defaults and overwrite
 * on next write, treating the disk as a hint not a source of truth.
 */

const DIR        = path.join(os.homedir(), '.nom', 'pet-mind');
const NOTES_FILE = path.join(DIR, 'notes.jsonl');
const MOOD_FILE  = path.join(DIR, 'mood.json');
const ABS_FILE   = path.join(DIR, 'absences.json');
const TICK_FILE  = path.join(DIR, 'last-tick.json');

/** Notes file size cap. Beyond this, callers should archive. We don't
 * implement archive rotation in Phase 1 since a normal user takes
 * months to reach this volume; revisit when the issue actually appears. */
export const NOTES_MAX_BYTES = 100 * 1024;

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

// ── Notes ──────────────────────────────────────────────────────────────

export async function appendNote(note: PetMindNote): Promise<void> {
  ensureDir();
  // JSONL: one note per line, ASCII-friendly JSON (no pretty-print).
  const line = JSON.stringify(note) + '\n';
  try {
    await fs.appendFile(NOTES_FILE, line, 'utf8');
  } catch (err) {
    console.error('[nom][pet-mind] appendNote failed:', err);
  }
}

/**
 * Pull the N most recent notes. Used to seed the LLM's context window
 * each tick so the pet has continuity across sessions. We read the
 * whole file and tail it — the file is capped at ~100 KB so this is a
 * trivial amount of work even at the high end.
 */
export async function readRecentNotes(limit: number): Promise<PetMindNote[]> {
  let text: string;
  try {
    text = await fs.readFile(NOTES_FILE, 'utf8');
  } catch {
    return [];
  }
  const out: PetMindNote[] = [];
  // Walk lines from the bottom up — quicker than reversing the whole array.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const n = JSON.parse(line) as PetMindNote;
      if (typeof n.ts === 'string' && typeof n.text === 'string') out.push(n);
    } catch {
      // Skip corrupt lines silently.
    }
  }
  return out.reverse(); // chronological order for LLM context
}

// ── Mood ───────────────────────────────────────────────────────────────

const VALID_MOODS: Mood[] = ['vivacious', 'normal', 'pensive', 'cranky', 'withdrawn'];

function defaultMoodState(): MoodState {
  return {
    current: 'normal',
    shiftedAt: new Date().toISOString(),
    reason: 'initial',
    recent: [],
  };
}

export async function readMood(): Promise<MoodState> {
  try {
    const text = await fs.readFile(MOOD_FILE, 'utf8');
    const parsed = JSON.parse(text);
    const current = VALID_MOODS.includes(parsed.current) ? parsed.current as Mood : 'normal';
    return {
      current,
      shiftedAt: typeof parsed.shiftedAt === 'string' ? parsed.shiftedAt : new Date().toISOString(),
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'restored',
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-20) : [],
    };
  } catch {
    return defaultMoodState();
  }
}

export async function writeMood(m: MoodState): Promise<void> {
  ensureDir();
  try {
    await fs.writeFile(MOOD_FILE, JSON.stringify(m, null, 2), 'utf8');
  } catch (err) {
    console.error('[nom][pet-mind] writeMood failed:', err);
  }
}

// ── Absences ───────────────────────────────────────────────────────────

function defaultAbsence(): AbsenceRecord {
  return { lastActiveAt: null, longestGap: null };
}

export async function readAbsence(): Promise<AbsenceRecord> {
  try {
    const text = await fs.readFile(ABS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return {
      lastActiveAt: typeof parsed.lastActiveAt === 'string' ? parsed.lastActiveAt : null,
      longestGap: parsed.longestGap && typeof parsed.longestGap === 'object'
        ? {
            hours: Number(parsed.longestGap.hours) || 0,
            endedAt: String(parsed.longestGap.endedAt),
          }
        : null,
    };
  } catch {
    return defaultAbsence();
  }
}

export async function writeAbsence(a: AbsenceRecord): Promise<void> {
  ensureDir();
  try {
    await fs.writeFile(ABS_FILE, JSON.stringify(a, null, 2), 'utf8');
  } catch (err) {
    console.error('[nom][pet-mind] writeAbsence failed:', err);
  }
}

/**
 * Record a user-activity event. Reads the previous lastActiveAt, computes
 * the gap, updates the longest-gap record if the new gap is bigger, then
 * stamps lastActiveAt to `now`. Returns the gap so the caller can decide
 * whether to fire a "you were gone" reaction.
 */
export async function touchAbsence(now: number): Promise<{ gapHours: number }> {
  const abs = await readAbsence();
  let gapHours = 0;
  if (abs.lastActiveAt) {
    gapHours = (now - Date.parse(abs.lastActiveAt)) / 3_600_000;
    if (!Number.isFinite(gapHours) || gapHours < 0) gapHours = 0;
  }
  const nowIso = new Date(now).toISOString();
  const nextLongest = !abs.longestGap || gapHours > abs.longestGap.hours
    ? { hours: Math.round(gapHours * 10) / 10, endedAt: nowIso }
    : abs.longestGap;
  await writeAbsence({
    lastActiveAt: nowIso,
    longestGap: nextLongest,
  });
  return { gapHours };
}

// ── Last tick (for the transparency widget) ────────────────────────────

export async function readLastTick(): Promise<LastTickRecord | null> {
  try {
    const text = await fs.readFile(TICK_FILE, 'utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed.at === 'string' && typeof parsed.decision === 'string') {
      return { at: parsed.at, decision: parsed.decision as LastTickRecord['decision'] };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeLastTick(rec: LastTickRecord): Promise<void> {
  ensureDir();
  try {
    await fs.writeFile(TICK_FILE, JSON.stringify(rec, null, 2), 'utf8');
  } catch (err) {
    console.error('[nom][pet-mind] writeLastTick failed:', err);
  }
}
