import * as fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Codex token weights — must match codex-source.ts so scan-time and
 * live-time numbers stay consistent.
 */
const WEIGHTS = {
  input: 1.0,
  cachedInput: 0.1,
  output: 5.0,
  reasoning: 5.0,
} as const;

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

interface Usage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function computeWeighted(u: Usage): number {
  return Math.round(
    (u.input_tokens          ?? 0) * WEIGHTS.input          +
    (u.cached_input_tokens   ?? 0) * WEIGHTS.cachedInput    +
    (u.output_tokens         ?? 0) * WEIGHTS.output         +
    (u.reasoning_output_tokens ?? 0) * WEIGHTS.reasoning,
  );
}

/**
 * Sum Codex `event_msg / token_count` events from ~/.codex/sessions/ whose
 * event timestamp falls in today. Mirrors today-scan.ts for Claude so that
 * launching nom mid-day shows accurate totals from both sources.
 */
export async function scanCodexTodayHistory(): Promise<ScanResult> {
  const recent = await scanCodexRecentHistory(1);
  const todayK = dayKeyFromMs(todayStartMs());
  return { tokens: recent.perDay[todayK] ?? 0, filesScanned: recent.filesScanned };
}

/**
 * Lifetime sweep of Codex sessions — mirrors `scanLifetimeHistory` for
 * Claude. No mtime/timestamp filter; returns all-time total plus per-day
 * buckets keyed by event timestamp.
 */
export async function scanCodexLifetimeHistory(): Promise<{
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
      if (event?.type !== 'event_msg') continue;
      if (event?.payload?.type !== 'token_count') continue;
      const u = event.payload?.info?.last_token_usage;
      if (!u) continue;
      const weighted = computeWeighted(u);
      total += weighted;
      const ts = Date.parse(event.timestamp);
      if (Number.isFinite(ts)) {
        const dayKey = dayKeyFromMs(ts);
        perDay[dayKey] = (perDay[dayKey] ?? 0) + weighted;
      }
    }
  }

  return { total, perDay, filesScanned: scanned };
}

/** Per-day weighted Codex tokens for the last `days` calendar days (incl. today). */
export async function scanCodexRecentHistory(days: number): Promise<{
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
      if (event?.type !== 'event_msg') continue;
      if (event?.payload?.type !== 'token_count') continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isFinite(ts) || ts < oldestMs) continue;
      const u = event.payload?.info?.last_token_usage;
      if (!u) continue;
      const dayKey = dayKeyFromMs(ts);
      perDay[dayKey] = (perDay[dayKey] ?? 0) + computeWeighted(u);
    }
  }

  return { perDay, filesScanned: scanned };
}
