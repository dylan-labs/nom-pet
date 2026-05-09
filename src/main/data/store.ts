import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LevelInfo, LevelUpEvent, LlmSettings, NomSettings, StateSnapshot } from '../../shared/types';
import { computeLevel } from './levels';
import { computeSeal, verifySeal } from './seal';

export interface WindowPosition {
  x: number;
  y: number;
  displayId?: number;
}

const SCHEMA_VERSION = 3; // bumped at 0.0.20 — added HMAC seal on cumulative + lastLevelIndex.

export interface NomState {
  schemaVersion: number;
  windowPosition: WindowPosition | null;
  tokens: {
    cumulative: number;
    daily: Record<string, number>;
  };
  /**
   * Last level index already shown to the user. Lets us detect level-ups
   * across token events without re-firing for cumulative we'd already
   * acknowledged. -1 means "uninitialised" — we'll seed it from the
   * current cumulative on first read so the user doesn't get a barrage of
   * historical level-ups on first launch after upgrading.
   */
  lastLevelIndex: number;
  startedAt: number;
  settings: NomSettings;
}

const DEFAULT_SETTINGS: NomSettings = {
  wanderEnabled: true,
  activePetSlug: null,
  llm: null,
  sources: {
    claudeCode: true,
    codex: true,
  },
};

const DEFAULT_STATE: NomState = {
  schemaVersion: SCHEMA_VERSION,
  windowPosition: null,
  tokens: { cumulative: 0, daily: {} },
  lastLevelIndex: -1,
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

      // Schema 1 → 2 was a token-formula change (weighted), old counts truly
      // incompatible. Reset cumulative for that path.
      // Schema 2 → 3 only added HMAC sealing — preserve the existing counts;
      // we'll seal them on the very next write so going forward they're
      // protected.
      if (parsed.schemaVersion < 2) {
        this.state = {
          ...clone(DEFAULT_STATE),
          windowPosition: parsed.windowPosition ?? null,
          startedAt: Date.now(),
        };
        this.scheduleWrite();
        console.log(`[nom] state migrated from schema ${parsed.schemaVersion} → ${SCHEMA_VERSION} (token counts reset)`);
      } else if (parsed.schemaVersion === 2 || parsed.schemaVersion === SCHEMA_VERSION) {
        const claimed = {
          cumulative: Math.max(0, Number(parsed.tokens?.cumulative ?? 0)),
          lastLevelIndex: typeof parsed.lastLevelIndex === 'number' ? parsed.lastLevelIndex : -1,
        };
        if (parsed.schemaVersion === SCHEMA_VERSION) {
          // Authentic v3 — verify the seal. Mismatch = tampered → reset.
          const sealOk = verifySeal(claimed, parsed.seal);
          if (!sealOk && (claimed.cumulative > 0 || claimed.lastLevelIndex > 0)) {
            console.warn('[nom] state seal mismatch — possible tamper. Resetting cumulative + level.');
            claimed.cumulative = 0;
            claimed.lastLevelIndex = -1;
          }
        } else {
          // v2 → v3 amnesty: pre-seal era, accept current value as legit.
          // Will be sealed on next write (scheduleWrite below).
          console.log('[nom] migrating state v2 → v3 (cumulative preserved, future writes sealed)');
          this.scheduleWrite();
        }
        this.state = {
          schemaVersion: SCHEMA_VERSION,
          windowPosition: parsed.windowPosition ?? null,
          tokens: {
            cumulative: claimed.cumulative,
            daily: typeof parsed.tokens?.daily === 'object' && parsed.tokens.daily ? parsed.tokens.daily : {},
          },
          lastLevelIndex: claimed.lastLevelIndex,
          startedAt: Number(parsed.startedAt) || Date.now(),
          settings: {
            wanderEnabled: typeof parsed.settings?.wanderEnabled === 'boolean'
              ? parsed.settings.wanderEnabled
              : DEFAULT_SETTINGS.wanderEnabled,
            activePetSlug: typeof parsed.settings?.activePetSlug === 'string'
              ? parsed.settings.activePetSlug
              : DEFAULT_SETTINGS.activePetSlug,
            llm: parsed.settings?.llm && typeof parsed.settings.llm === 'object'
              ? {
                  enabled: !!parsed.settings.llm.enabled,
                  endpoint: String(parsed.settings.llm.endpoint ?? ''),
                  model: String(parsed.settings.llm.model ?? ''),
                  apiKey: parsed.settings.llm.apiKey
                    ? String(parsed.settings.llm.apiKey)
                    : null,
                }
              : DEFAULT_SETTINGS.llm,
            sources: {
              claudeCode: typeof parsed.settings?.sources?.claudeCode === 'boolean'
                ? parsed.settings.sources.claudeCode
                : DEFAULT_SETTINGS.sources.claudeCode,
              codex: typeof parsed.settings?.sources?.codex === 'boolean'
                ? parsed.settings.sources.codex
                : DEFAULT_SETTINGS.sources.codex,
            },
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

  /**
   * Apply a token delta. Returns the post-update snapshot AND a level-up
   * event if the cumulative crossed one or more level thresholds.
   * Caller (main/index.ts) fans the level-up event out to the renderer.
   */
  addTokens(delta: number): { snapshot: StateSnapshot; levelUp: LevelUpEvent | null } {
    let levelUp: LevelUpEvent | null = null;
    if (delta > 0) {
      // Lazy seed: if we've never recorded a level (fresh upgrade from a
      // pre-leveling install), align lastLevelIndex with the current
      // cumulative BEFORE applying delta so we don't fire a barrage of
      // historical level-ups for tokens already eaten.
      if (this.state.lastLevelIndex < 0) {
        this.state.lastLevelIndex = computeLevel(this.state.tokens.cumulative).index;
      }
      const before = this.state.lastLevelIndex;

      const key = todayKey();
      this.state.tokens.cumulative += delta;
      this.state.tokens.daily[key] = (this.state.tokens.daily[key] ?? 0) + delta;

      const after = computeLevel(this.state.tokens.cumulative);
      if (after.index > before) {
        const fromLevel = computeLevel(this.state.tokens.cumulative - delta);
        levelUp = {
          from: fromLevel,
          to: after,
          tierJumped: fromLevel.tier !== after.tier,
          cumulative: this.state.tokens.cumulative,
        };
        this.state.lastLevelIndex = after.index;
      }

      this.pruneDaily();
      this.scheduleWrite();
    }
    return { snapshot: this.snapshot(), levelUp };
  }

  getLevel(): LevelInfo {
    return computeLevel(this.state.tokens.cumulative);
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

  setSourceEnabled(source: 'claudeCode' | 'codex', enabled: boolean): NomSettings {
    this.state.settings.sources[source] = enabled;
    this.scheduleWrite();
    return this.getSettings();
  }

  setLlmEnabled(enabled: boolean): NomSettings {
    if (this.state.settings.llm) {
      this.state.settings.llm.enabled = enabled;
    } else {
      // First-time toggle without prior config: stub something the user
      // can complete later via "打开配置文件".
      this.state.settings.llm = {
        enabled,
        endpoint: '',
        model: '',
        apiKey: null,
      };
    }
    this.scheduleWrite();
    return this.getSettings();
  }

  setLlmSettings(llm: LlmSettings | null): NomSettings {
    this.state.settings.llm = llm;
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
    // Seal cumulative + lastLevelIndex so naive edits to state.json get
    // caught by verifySeal() on next load. The seal lives at the top level
    // alongside the state fields so it's obvious in the file.
    const seal = computeSeal({
      cumulative: this.state.tokens.cumulative,
      lastLevelIndex: this.state.lastLevelIndex,
    });
    const payload = { ...this.state, seal };
    const data = JSON.stringify(payload, null, 2);
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
