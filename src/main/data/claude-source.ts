import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';
import { computeWeightedTokens, type AnthropicUsage } from './usage';
import type { SourceId } from '../../shared/types';

export interface RawTokensEvent {
  delta: number;
  source: SourceId;
  timestamp: number;
}

export interface RawSessionEvent {
  source: SourceId;
  sessionId: string;
  kind: 'start';
  timestamp: number;
}

export interface RawThinkingEvent {
  source: SourceId;
  sessionId: string;
  kind: 'start' | 'end';
  timestamp: number;
}

export interface ClaudeSourceEvents {
  tokens: (event: RawTokensEvent) => void;
  session: (event: RawSessionEvent) => void;
  thinking: (event: RawThinkingEvent) => void;
}

export declare interface ClaudeSource {
  on<K extends keyof ClaudeSourceEvents>(event: K, listener: ClaudeSourceEvents[K]): this;
  emit<K extends keyof ClaudeSourceEvents>(event: K, ...args: Parameters<ClaudeSourceEvents[K]>): boolean;
}

const THINKING_TIMEOUT_MS = 3 * 60 * 1000;

export class ClaudeSource extends EventEmitter {
  readonly id: SourceId = 'claude-code';
  private watcher: FSWatcher | null = null;
  private offsets = new Map<string, number>();
  private rootDir: string;
  private ready = false;
  private thinkingFiles = new Set<string>();
  private thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    super();
    this.rootDir = path.join(os.homedir(), '.claude', 'projects');
  }

  start(): void {
    if (this.watcher) return; // idempotent: settings toggles re-call this
    if (!fs.existsSync(this.rootDir)) {
      // No Claude Code transcripts on this machine — silently no-op.
      return;
    }

    this.watcher = chokidar.watch(this.rootDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 4,
    });

    this.watcher.on('add', (file) => {
      if (!file.endsWith('.jsonl')) return;
      // For files that exist when we start, jump past their current size so
      // we only count tokens written from now on. For brand-new files (size 0)
      // this is also correct.
      fs.promises.stat(file)
        .then((stat) => this.offsets.set(file, stat.size))
        .catch(() => {/* gone before we could stat — ignore */});
      // Files appearing AFTER chokidar's initial scan = a fresh Claude Code
      // session just opened. The renderer reacts (wake + greet bubble).
      if (this.ready) {
        this.emit('session', {
          source: 'claude-code',
          sessionId: path.basename(file, '.jsonl'),
          kind: 'start',
          timestamp: Date.now(),
        });
      }
    });

    this.watcher.on('ready', () => {
      this.ready = true;
    });

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
    for (const t of this.thinkingTimers.values()) clearTimeout(t);
    this.thinkingTimers.clear();
    this.thinkingFiles.clear();
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
      // File was truncated/replaced; reset and skip this round.
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

    // If the trailing fragment is a partial line, leave it for next round.
    let consumedBytes = len;
    if (!text.endsWith('\n') && lines.length > 0) {
      const partial = lines.pop()!;
      consumedBytes -= Buffer.byteLength(partial, 'utf8');
    }
    this.offsets.set(file, offset + consumedBytes);

    for (const line of lines) {
      if (!line.trim()) continue;
      this.parseAndEmit(line, file);
    }
  }

  private parseAndEmit(line: string, file: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    const type = (event as { type?: unknown }).type;
    const sessionId = path.basename(file, '.jsonl');

    if (type === 'user') {
      // User submitted (or tool result came back) — Claude is now thinking.
      if (!this.thinkingFiles.has(file)) {
        this.thinkingFiles.add(file);
        this.emit('thinking', { source: 'claude-code', sessionId, kind: 'start', timestamp: Date.now() });
      }
      this.armThinkingTimeout(file, sessionId);
      return;
    }

    if (type !== 'assistant') return;

    // Assistant event = Claude responded; clear any pending "thinking" state.
    if (this.thinkingFiles.has(file)) {
      this.thinkingFiles.delete(file);
      this.clearThinkingTimeout(file);
      this.emit('thinking', { source: 'claude-code', sessionId, kind: 'end', timestamp: Date.now() });
    }

    const u = (event as AssistantEvent).message?.usage;
    if (!u) return;
    const weighted = computeWeightedTokens(u);
    if (weighted > 0) {
      this.emit('tokens', { delta: weighted, source: 'claude-code', timestamp: Date.now() });
    }
  }

  /** Safety: if no assistant event arrives within 3 min, force-end thinking. */
  private armThinkingTimeout(file: string, sessionId: string): void {
    this.clearThinkingTimeout(file);
    const id = setTimeout(() => {
      this.thinkingTimers.delete(file);
      if (this.thinkingFiles.delete(file)) {
        this.emit('thinking', { source: 'claude-code', sessionId, kind: 'end', timestamp: Date.now() });
      }
    }, THINKING_TIMEOUT_MS);
    this.thinkingTimers.set(file, id);
  }

  private clearThinkingTimeout(file: string): void {
    const t = this.thinkingTimers.get(file);
    if (t) {
      clearTimeout(t);
      this.thinkingTimers.delete(file);
    }
  }
}

interface AssistantEvent {
  type: 'assistant';
  message?: { usage?: AnthropicUsage };
}
