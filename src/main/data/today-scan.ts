import * as fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeWeightedTokens } from './usage';

const ROOT = path.join(os.homedir(), '.claude', 'projects');

export interface ScanResult {
  tokens: number;
  filesScanned: number;
}

function todayStartMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayStartMs(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function dayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function listJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let items: Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...(await listJsonl(p)));
    } else if (item.isFile() && item.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Sum tokens from assistant events in ~/.claude/projects/ whose timestamp
 * falls in the user's local "today". Used at startup to seed today's count
 * so opening nom mid-day shows real numbers, not 0.
 *
 * Cumulative is intentionally NOT updated by this — it tracks live-only.
 */
export async function scanTodayHistory(): Promise<ScanResult> {
  const recent = await scanRecentHistory(1);
  const todayK = dayKeyFromMs(todayStartMs());
  return { tokens: recent.perDay[todayK] ?? 0, filesScanned: recent.filesScanned };
}

/**
 * Lifetime sweep: read every JSONL we can find under `~/.claude/projects/`
 * with no mtime/timestamp filter, returning the all-time weighted total
 * plus per-day buckets for every date encountered.
 *
 * Slower than `scanRecentHistory` (no mtime skip), so callers should run
 * this in the background after the pet window is already up. Used to
 * rebuild cumulative + daily when `~/.nom/state.json` has been wiped or
 * truncated — we don't want a user's level to disappear just because they
 * deleted `~/.nom/`.
 */
export async function scanLifetimeHistory(): Promise<{
  total: number;
  perDay: Record<string, number>;
  filesScanned: number;
}> {
  const perDay: Record<string, number> = {};
  let total = 0;
  let scanned = 0;

  const files = await listJsonl(ROOT);
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    scanned++;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== 'assistant') continue;
      const u = event.message?.usage;
      if (!u) continue;
      const weighted = computeWeightedTokens(u);
      total += weighted;
      // Per-day bucket only when timestamp is parseable; some old events
      // may lack one but should still count toward cumulative.
      const ts = Date.parse(event.timestamp);
      if (Number.isFinite(ts)) {
        const dayKey = dayKeyFromMs(ts);
        perDay[dayKey] = (perDay[dayKey] ?? 0) + weighted;
      }
    }
  }

  return { total, perDay, filesScanned: scanned };
}

/**
 * Scan the last `days` calendar days (including today) and return per-day
 * weighted token totals. Lets us seed `tokens.daily` with history so the
 * daily-recap bubble has data to compare against on the user's first launch
 * after install.
 */
export async function scanRecentHistory(days: number): Promise<{
  perDay: Record<string, number>;
  filesScanned: number;
}> {
  const oldestMs = dayStartMs(days - 1);
  const perDay: Record<string, number> = {};
  let scanned = 0;

  const files = await listJsonl(ROOT);
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < oldestMs) continue;
    } catch {
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    scanned++;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== 'assistant') continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isFinite(ts) || ts < oldestMs) continue;
      const u = event.message?.usage;
      if (!u) continue;
      const dayKey = dayKeyFromMs(ts);
      perDay[dayKey] = (perDay[dayKey] ?? 0) + computeWeightedTokens(u);
    }
  }

  return { perDay, filesScanned: scanned };
}
