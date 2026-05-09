import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NomSettings, StateSnapshot } from '../../shared/types';

export interface WindowPosition {
  x: number;
  y: number;
  displayId?: number;
}

const SCHEMA_VERSION = 2; // bumped at 0.0.7 — token formula changed (weighted), old counts incompatible.

export interface NomState {
  schemaVersion: number;
  windowPosition: WindowPosition | null;
  tokens: {
    cumulative: number;
    daily: Record<string, number>;
  };
  startedAt: number;
  settings: NomSettings;
}

const DEFAULT_SETTINGS: NomSettings = {
  wanderEnabled: true,
  activePetSlug: null,
};

const DEFAULT_STATE: NomState = {
  schemaVersion: SCHEMA_VERSION,
  windowPosition: null,
  tokens: { cumulative: 0, daily: {} },
  startedAt: 0,
  settings: { ...DEFAULT_SETTINGS },
};

const MAX_DAILY_ENTRIES = 60;
const WRITE_DEBOUNCE_MS = 1000;

export function todayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Store {
  private dir: string;
  private file: string;
  private state: NomState;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor() {
    this.dir = path.join(os.homedir(), '.nom');
    this.file = path.join(this.dir, 'state.json');
    this.state = clone(DEFAULT_STATE);
  }

  async load(): Promise<NomState> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        // Older schema → token counts incompatible. Reset counts but keep
        // window position (it has nothing to do with the formula).
        this.state = {
          ...clone(DEFAULT_STATE),
          windowPosition: parsed.windowPosition ?? null,
          startedAt: Date.now(),
        };
        this.scheduleWrite();
        console.log(`[nom] state migrated from schema ${parsed.schemaVersion} → ${SCHEMA_VERSION} (token counts reset)`);
      } else {
        this.state = {
          schemaVersion: SCHEMA_VERSION,
          windowPosition: parsed.windowPosition ?? null,
          tokens: {
            cumulative: Math.max(0, Number(parsed.tokens?.cumulative ?? 0)),
            daily: typeof parsed.tokens?.daily === 'object' && parsed.tokens.daily ? parsed.tokens.daily : {},
          },
          startedAt: Number(parsed.startedAt) || Date.now(),
          settings: {
            wanderEnabled: typeof parsed.settings?.wanderEnabled === 'boolean'
              ? parsed.settings.wanderEnabled
              : DEFAULT_SETTINGS.wanderEnabled,
            activePetSlug: typeof parsed.settings?.activePetSlug === 'string'
              ? parsed.settings.activePetSlug
              : DEFAULT_SETTINGS.activePetSlug,
          },
        };
      }
    } catch {
      this.state = { ...clone(DEFAULT_STATE), startedAt: Date.now() };
      this.scheduleWrite();
    }
    return this.state;
  }

  snapshot(): StateSnapshot {
    return {
      cumulative: this.state.tokens.cumulative,
      today: this.state.tokens.daily[todayKey()] ?? 0,
    };
  }

  getWindowPosition(): WindowPosition | null {
    return this.state.windowPosition;
  }

  addTokens(delta: number): StateSnapshot {
    if (delta > 0) {
      const key = todayKey();
      this.state.tokens.cumulative += delta;
      this.state.tokens.daily[key] = (this.state.tokens.daily[key] ?? 0) + delta;
      this.pruneDaily();
      this.scheduleWrite();
    }
    return this.snapshot();
  }

  setWindowPosition(pos: WindowPosition): void {
    this.state.windowPosition = pos;
    this.scheduleWrite();
  }

  getSettings(): NomSettings {
    return { ...this.state.settings };
  }

  setWanderEnabled(enabled: boolean): NomSettings {
    this.state.settings.wanderEnabled = enabled;
    this.scheduleWrite();
    return this.getSettings();
  }

  setActivePetSlug(slug: string | null): NomSettings {
    this.state.settings.activePetSlug = slug;
    this.scheduleWrite();
    return this.getSettings();
  }

  /**
   * Apply a today-baseline from history scan. Only updates today's slot
   * (does NOT touch cumulative — cumulative is live-only). Uses Math.max
   * so we never lose tokens already counted live this session.
   */
  setTodayBaseline(amount: number): StateSnapshot {
    if (amount > 0) {
      const key = todayKey();
      this.state.tokens.daily[key] = Math.max(this.state.tokens.daily[key] ?? 0, amount);
      this.scheduleWrite();
    }
    return this.snapshot();
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
      await this.write();
    } else if (this.writing) {
      await this.writing;
    }
  }

  private pruneDaily(): void {
    const keys = Object.keys(this.state.tokens.daily).sort();
    if (keys.length <= MAX_DAILY_ENTRIES) return;
    for (const k of keys.slice(0, keys.length - MAX_DAILY_ENTRIES)) {
      delete this.state.tokens.daily[k];
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writing = this.write().finally(() => { this.writing = null; });
    }, WRITE_DEBOUNCE_MS);
  }

  private async write(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    const data = JSON.stringify(this.state, null, 2);
    try {
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, this.file);
    } catch (err) {
      console.error('[nom] state write failed:', err);
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
