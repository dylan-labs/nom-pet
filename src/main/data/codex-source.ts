import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SourceId } from '../../shared/types';
import type { RawSessionEvent, RawTokensEvent } from './claude-source';

/**
 * Token weights for Codex (OpenAI / GPT-5 family).
 * Anchored to input=1.0 to match Claude's "input-token-equivalent" semantics
 * so the running counter has consistent magnitude across sources.
 */
const WEIGHTS = {
  input: 1.0,
  cachedInput: 0.1,  // cache hits are ~10% of input price
  output: 5.0,       // ~5× input, mirrors Claude
  reasoning: 5.0,    // GPT-5 reasoning tokens billed as output
} as const;

interface CodexLastTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function computeWeighted(usage: CodexLastTokenUsage): number {
  return Math.round(
    (usage.input_tokens          ?? 0) * WEIGHTS.input          +
    (usage.cached_input_tokens   ?? 0) * WEIGHTS.cachedInput    +
    (usage.output_tokens         ?? 0) * WEIGHTS.output         +
    (usage.reasoning_output_tokens ?? 0) * WEIGHTS.reasoning,
  );
}

export class CodexSource extends EventEmitter {
  readonly id: SourceId = 'codex';
  private watcher: FSWatcher | null = null;
  private offsets = new Map<string, number>();
  private rootDir: string;
  private ready = false;

  constructor() {
    super();
    this.rootDir = path.join(os.homedir(), '.codex', 'sessions');
  }

  start(): void {
    if (this.watcher) return; // idempotent: settings toggles re-call this
    if (!fs.existsSync(this.rootDir)) {
      // Codex CLI not installed on this machine — silently no-op.
      return;
    }

    this.watcher = chokidar.watch(this.rootDir, {
      persistent: true,
      ignoreInitial: false,
      // Sessions live at sessions/<year>/<month>/<day>/rollout-*.jsonl;
      // depth 6 leaves comfortable headroom in case Codex adds a level.
      depth: 6,
    });

    this.watcher.on('add', (file) => {
      if (!file.endsWith('.jsonl')) return;
      fs.promises.stat(file)
        .then((stat) => this.offsets.set(file, stat.size))
        .catch(() => {/* gone before we could stat — ignore */});
      if (this.ready) {
        this.emit('session', {
          source: this.id,
          sessionId: extractSessionId(file),
          kind: 'start',
          timestamp: Date.now(),
        } as RawSessionEvent);
      }
    });

    this.watcher.on('ready', () => { this.ready = true; });

    this.watcher.on('change', (file) => {
      if (!file.endsWith('.jsonl')) return;
      void this.processChange(file);
    });

    this.watcher.on('unlink', (file) => {
      this.offsets.delete(file);
    });
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = null;
    this.offsets.clear();
    this.ready = false;
  }

  private async processChange(file: string): Promise<void> {
    const offset = this.offsets.get(file) ?? 0;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return;
    }

    if (stat.size === offset) return;
    if (stat.size < offset) {
      this.offsets.set(file, stat.size);
      return;
    }

    const len = stat.size - offset;
    const buffer = Buffer.alloc(len);

    try {
      const fd = await fs.promises.open(file, 'r');
      try {
        await fd.read(buffer, 0, len, offset);
      } finally {
        await fd.close();
      }
    } catch {
      return;
    }

    const text = buffer.toString('utf8');
    const lines = text.split('\n');

    let consumedBytes = len;
    if (!text.endsWith('\n') && lines.length > 0) {
      const partial = lines.pop()!;
      consumedBytes -= Buffer.byteLength(partial, 'utf8');
    }
    this.offsets.set(file, offset + consumedBytes);

    for (const line of lines) {
      if (!line.trim()) continue;
      this.parseAndEmit(line);
    }
  }

  private parseAndEmit(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const e = event as { type?: unknown; payload?: { type?: unknown; info?: { last_token_usage?: CodexLastTokenUsage } } };
    if (e.type !== 'event_msg') return;
    if (e.payload?.type !== 'token_count') return;

    const usage = e.payload.info?.last_token_usage;
    if (!usage) return;
    const weighted = computeWeighted(usage);
    if (weighted > 0) {
      this.emit('tokens', {
        delta: weighted,
        source: this.id,
        timestamp: Date.now(),
      } as RawTokensEvent);
    }
  }
}

/**
 * Codex filenames look like:
 *   rollout-2026-05-08T15-47-52-019e068e-a7a9-7da2-8187-47f373d4b46b.jsonl
 * Extract the trailing UUID for use as our session id.
 */
function extractSessionId(file: string): string {
  const base = path.basename(file, '.jsonl');
  const m = base.match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return m ? m[1]! : base;
}
