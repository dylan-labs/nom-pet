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
  const startMs = todayStartMs();
  let total = 0;
  let scanned = 0;

  const files = await listJsonl(ROOT);
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < startMs) continue;
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
      if (!Number.isFinite(ts) || ts < startMs) continue;
      const u = event.message?.usage;
      if (!u) continue;
      total += computeWeightedTokens(u);
    }
  }

  return { tokens: total, filesScanned: scanned };
}
