import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AutonomySettings, DailyReport, LevelInfo, LevelUpEvent, LlmSettings, NomSettings, SoulKernel, SoulPreset, SourceId, StateSnapshot, Weekday, WeeklyDayBucket, WeeklyReport } from '../../shared/types';
import { computeLevel, levelBadgeAt } from './levels';
import { computeSeal, verifySeal } from './seal';

export interface WindowPosition {
  x: number;
  y: number;
  displayId?: number;
}

const SCHEMA_VERSION = 6; // v6 (0.0.25): settings.autonomy for the autonomous-pet feature (Tick + Pet Mind).

export interface NomState {
  schemaVersion: number;
  windowPosition: WindowPosition | null;
  tokens: {
    cumulative: number;
    daily: Record<string, number>;
    /**
     * Today's token intake broken down by source. Lets the live "today"
     * counter filter against the user's current enabled-sources setting
     * — turning Claude Code off should drop the visible number to just
     * Codex, not leave a stale total. Resets when the date rolls over.
     * `todayBucketDate` records which date the bucket is valid for.
     */
    todayBySource: Partial<Record<SourceId, number>>;
    todayBucketDate: string;
  };
  /**
   * Last level index already shown to the user. Lets us detect level-ups
   * across token events without re-firing for cumulative we'd already
   * acknowledged. -1 means "uninitialised" — we'll seed it from the
   * current cumulative on first read so the user doesn't get a barrage of
   * historical level-ups on first launch after upgrading.
   */
  lastLevelIndex: number;
  /**
   * Date (YYYY-MM-DD) of the most recent day on which the daily report
   * bubble was shown. Lets us only fire it once per day, and only when
   * the user opens nom on a day they haven't yet seen yesterday's recap.
   */
  lastDailyReportShownOn: string | null;
  startedAt: number;
  settings: NomSettings;
}

const DEFAULT_AUTONOMY: AutonomySettings = {
  // OFF by default — users opt in after reading the privacy disclosure.
  // Turning autonomy on lets the pet send mood + recent self-notes to
  // the configured LLM, which is materially more info than v0.0.24.
  enabled: false,
  tickIntervalMin: 30,
  maxBubblesPerDay: 2,
  allowAskMode: true,
};

const DEFAULT_SETTINGS: NomSettings = {
  wanderEnabled: true,
  activePetSlug: null,
  llm: null,
  sources: {
    claudeCode: true,
    codex: true,
  },
  petName: 'Mochi',
  onboarded: false,
  soulKernel: null,
  autonomy: { ...DEFAULT_AUTONOMY },
};

function parseAutonomy(raw: unknown): AutonomySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTONOMY };
  const o = raw as Partial<AutonomySettings>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_AUTONOMY.enabled,
    tickIntervalMin: typeof o.tickIntervalMin === 'number' && Number.isFinite(o.tickIntervalMin)
      ? Math.max(15, Math.min(90, Math.round(o.tickIntervalMin)))
      : DEFAULT_AUTONOMY.tickIntervalMin,
    maxBubblesPerDay: typeof o.maxBubblesPerDay === 'number' && Number.isFinite(o.maxBubblesPerDay)
      ? Math.max(0, Math.min(10, Math.round(o.maxBubblesPerDay)))
      : DEFAULT_AUTONOMY.maxBubblesPerDay,
    allowAskMode: typeof o.allowAskMode === 'boolean' ? o.allowAskMode : DEFAULT_AUTONOMY.allowAskMode,
  };
}

const VALID_SOUL_PRESETS: SoulPreset[] = [
  'tsundere-architect', 'old-tcm-doctor', 'tang-concubine',
  'cursed-doll', 'aloof-otaku', 'philosopher-stray', 'custom',
];

const VALID_SOURCES: SourceId[] = ['claude-code', 'codex'];

function sanitizeTodayBySource(raw: unknown): Partial<Record<SourceId, number>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<SourceId, number>> = {};
  for (const k of VALID_SOURCES) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

function parseSoulKernel(raw: unknown): SoulKernel | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { preset?: unknown; text?: unknown };
  if (typeof o.preset !== 'string' || !VALID_SOUL_PRESETS.includes(o.preset as SoulPreset)) return null;
  if (typeof o.text !== 'string' || o.text.trim().length === 0) return null;
  return { preset: o.preset as SoulPreset, text: o.text.trim().slice(0, 200) };
}

const DEFAULT_STATE: NomState = {
  schemaVersion: SCHEMA_VERSION,
  windowPosition: null,
  tokens: { cumulative: 0, daily: {}, todayBySource: {}, todayBucketDate: todayKey() },
  lastLevelIndex: -1,
  lastDailyReportShownOn: null,
  startedAt: 0,
  settings: { ...DEFAULT_SETTINGS },
};

const MAX_DAILY_ENTRIES = 60;
const WRITE_DEBOUNCE_MS = 1000;

export function todayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Date key N days before today (0 = today, 1 = yesterday, etc). */
function dayKeyOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_LABELS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO 8601 week-numbering year + week (Mon-anchored, Thursday's year wins). */
function isoWeek(date: Date): { year: number; week: number } {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7; // Mon=1..Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: target.getUTCFullYear(), week };
}

/** The 7 Date objects (Mon..Sun) of the ISO week containing `anchor`. */
function weekRange(anchor: Date): Date[] {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  const isoDay = d.getDay() || 7; // Mon=1..Sun=7
  const monday = new Date(d);
  monday.setDate(d.getDate() - (isoDay - 1));
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    days.push(x);
  }
  return days;
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
      } else if (parsed.schemaVersion >= 2 && parsed.schemaVersion <= SCHEMA_VERSION) {
        // Any version from 2 up to the current schema migrates forward
        // by preserving all the fields we still understand and filling
        // newly-added ones with defaults. Critically: BEFORE this fix
        // the branch only fired on v===2 || v===SCHEMA_VERSION, so a
        // user on v3/v4/v5 would silently fall through, this.state would
        // stay at the constructor's DEFAULT_STATE, and the next write
        // would clobber petName / soulKernel / llm with defaults.
        const claimed = {
          cumulative: Math.max(0, Number(parsed.tokens?.cumulative ?? 0)),
          lastLevelIndex: typeof parsed.lastLevelIndex === 'number' ? parsed.lastLevelIndex : -1,
        };
        if (parsed.schemaVersion === SCHEMA_VERSION) {
          // Authentic current-version state — verify the seal. Mismatch
          // = tampered (or a really old pre-seal file slipped through
          // somehow) → reset cumulative + level only, keep the rest.
          const sealOk = verifySeal(claimed, parsed.seal);
          if (!sealOk && (claimed.cumulative > 0 || claimed.lastLevelIndex > 0)) {
            console.warn('[nom] state seal mismatch — possible tamper. Resetting cumulative + level.');
            claimed.cumulative = 0;
            claimed.lastLevelIndex = -1;
          }
        } else {
          // Older schema → migrate up. cumulative/lastLevelIndex were
          // either already sealed (v3+) or never sealed (v2); either way
          // we accept the current value and reseal on the very next
          // write. lifetime-reconcile (in main) will also kick in and
          // catch up if anything got under-counted live.
          console.log(`[nom] migrating state v${parsed.schemaVersion} → v${SCHEMA_VERSION}`);
          this.scheduleWrite();
        }
        // Per-source today bucket — only valid for the date in
        // todayBucketDate. If we loaded a state from yesterday, the
        // bucket is stale and gets reset so toggling sources today
        // doesn't show last night's leftovers.
        const today = todayKey();
        const persistedBucketDate = typeof parsed.tokens?.todayBucketDate === 'string'
          ? parsed.tokens.todayBucketDate
          : null;
        const todayBySource: Partial<Record<SourceId, number>> =
          persistedBucketDate === today && parsed.tokens?.todayBySource && typeof parsed.tokens.todayBySource === 'object'
            ? sanitizeTodayBySource(parsed.tokens.todayBySource)
            : {};

        this.state = {
          schemaVersion: SCHEMA_VERSION,
          windowPosition: parsed.windowPosition ?? null,
          tokens: {
            cumulative: claimed.cumulative,
            daily: typeof parsed.tokens?.daily === 'object' && parsed.tokens.daily ? parsed.tokens.daily : {},
            todayBySource,
            todayBucketDate: today,
          },
          lastLevelIndex: claimed.lastLevelIndex,
          lastDailyReportShownOn: typeof parsed.lastDailyReportShownOn === 'string'
            ? parsed.lastDailyReportShownOn
            : null,
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
            petName: typeof parsed.settings?.petName === 'string' && parsed.settings.petName.trim().length > 0
              ? parsed.settings.petName.trim().slice(0, 24)
              : DEFAULT_SETTINGS.petName,
            onboarded: typeof parsed.settings?.onboarded === 'boolean'
              ? parsed.settings.onboarded
              : DEFAULT_SETTINGS.onboarded,
            soulKernel: parseSoulKernel(parsed.settings?.soulKernel),
            autonomy: parseAutonomy(parsed.settings?.autonomy),
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
      today: this.filteredTodayTotal(),
    };
  }

  /**
   * Sum today's per-source intake filtered against the user's currently
   * enabled sources. Falls back to the daily map's total when the
   * per-source bucket is empty (e.g. mid-day on fresh install before
   * any live event has landed) — that way the counter never reads zero
   * just because we haven't seen a `tokens` event yet.
   */
  private filteredTodayTotal(): number {
    const bucket = this.state.tokens.todayBySource;
    const enabled = this.state.settings.sources;
    let sum = 0;
    if (enabled.claudeCode) sum += bucket['claude-code'] ?? 0;
    if (enabled.codex)      sum += bucket['codex']       ?? 0;
    // If both sources are enabled and the bucket is empty, prefer the
    // daily map (covers the moment between launch and the first live
    // event — the 7-day scan has already seeded daily but not the
    // per-source bucket).
    if (sum === 0 && enabled.claudeCode && enabled.codex) {
      return this.state.tokens.daily[todayKey()] ?? 0;
    }
    return sum;
  }

  getWindowPosition(): WindowPosition | null {
    return this.state.windowPosition;
  }

  /**
   * Apply a token delta from one source. Returns the post-update snapshot
   * AND a level-up event if the cumulative crossed one or more level
   * thresholds. Caller (main/index.ts) fans the level-up event out to
   * the renderer.
   *
   * `source` lets us bucket today's intake per source so the UI can
   * filter the visible count against the user's enabled-source set.
   */
  addTokens(delta: number, source: SourceId): { snapshot: StateSnapshot; levelUp: LevelUpEvent | null } {
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

      // Roll the per-source today bucket if the date changed mid-run
      // (long-running session crossed midnight). Otherwise accumulate
      // into the current source's slot.
      if (this.state.tokens.todayBucketDate !== key) {
        this.state.tokens.todayBySource = {};
        this.state.tokens.todayBucketDate = key;
      }
      this.state.tokens.todayBySource[source] =
        (this.state.tokens.todayBySource[source] ?? 0) + delta;

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

  /**
   * Close the gap left by a stop()/use/start() cycle on a data source.
   * When the user toggles a source off, uses the tool, and toggles back
   * on, the chokidar watcher sets its offset to the current file size
   * and ignores the in-between events. Calling this with the scanned
   * "today total for this source" pulls those missed tokens back into
   * the per-source bucket AND into cumulative / daily so the user's
   * level isn't shorted either. Math.max — never decreases anything.
   *
   * Returns the delta added to cumulative so the caller can log /
   * decide whether to push a state-reconciled event.
   */
  backfillSourceToday(source: SourceId, scannedAmount: number): { bumpedCumulative: number } {
    if (scannedAmount <= 0) return { bumpedCumulative: 0 };
    const key = todayKey();
    if (this.state.tokens.todayBucketDate !== key) {
      this.state.tokens.todayBySource = {};
      this.state.tokens.todayBucketDate = key;
    }
    const current = this.state.tokens.todayBySource[source] ?? 0;
    if (scannedAmount <= current) return { bumpedCumulative: 0 };
    const bump = scannedAmount - current;
    this.state.tokens.todayBySource[source] = scannedAmount;
    this.state.tokens.cumulative += bump;
    this.state.tokens.daily[key] = (this.state.tokens.daily[key] ?? 0) + bump;
    // Silently sync lastLevelIndex to the new cumulative — this is
    // recovery, not progress, so no level-up event fires.
    this.state.lastLevelIndex = computeLevel(this.state.tokens.cumulative).index;
    this.scheduleWrite();
    return { bumpedCumulative: bump };
  }

  /**
   * Seed today's per-source bucket from a startup scan. Uses Math.max
   * (mirrors setDayBaseline) so concurrent live events that beat the
   * scan to the punch aren't clobbered. Resets the bucket if the
   * persisted date is stale.
   */
  setTodayBaselineForSource(source: SourceId, amount: number): void {
    if (amount <= 0) return;
    const key = todayKey();
    if (this.state.tokens.todayBucketDate !== key) {
      this.state.tokens.todayBySource = {};
      this.state.tokens.todayBucketDate = key;
    }
    const current = this.state.tokens.todayBySource[source] ?? 0;
    this.state.tokens.todayBySource[source] = Math.max(current, amount);
    this.scheduleWrite();
  }

  getLevel(): LevelInfo {
    return computeLevel(this.state.tokens.cumulative);
  }

  /**
   * Raise cumulative to at least `floor` if our recorded value is lower.
   * Used to recover from a wiped/tampered state.json by reseeding from the
   * canonical transcript files (Claude + Codex), which the user can't
   * accidentally delete the same way they can delete ~/.nom/.
   *
   * lastLevelIndex is silently reseeded to match the new cumulative — this
   * is recovery, not progress, so no level-up event fires. Returns whether
   * anything actually changed so the caller can decide whether to push an
   * update to the renderer.
   */
  reconcileCumulativeFloor(floor: number): { changed: boolean; snapshot: StateSnapshot; level: LevelInfo } {
    if (floor > this.state.tokens.cumulative) {
      this.state.tokens.cumulative = floor;
      this.state.lastLevelIndex = computeLevel(floor).index;
      this.scheduleWrite();
      return { changed: true, snapshot: this.snapshot(), level: this.getLevel() };
    }
    return { changed: false, snapshot: this.snapshot(), level: this.getLevel() };
  }

  /**
   * Yesterday's recap. Returns null if there's no data for yesterday
   * (user wasn't active / weekend / holiday) — we'd rather stay quiet
   * than fabricate a "you fed me 0 tokens, sad" message.
   */
  computeDailyReport(): DailyReport | null {
    const yesterdayKey = dayKeyOffset(1);
    const yesterdayTokens = this.state.tokens.daily[yesterdayKey] ?? 0;
    if (yesterdayTokens <= 0) return null;

    const dayBeforeTokens = this.state.tokens.daily[dayKeyOffset(2)] ?? 0;

    // 7-day average — only count days that actually have data, so a
    // brand-new user with one day of history doesn't see "vs avg ÷7".
    let sum = 0;
    let count = 0;
    for (let i = 1; i <= 7; i++) {
      const v = this.state.tokens.daily[dayKeyOffset(i)];
      if (typeof v === 'number') {
        sum += v;
        count++;
      }
    }
    const weekAvgTokens = count > 0 ? Math.round(sum / count) : 0;

    return { yesterdayKey, yesterdayTokens, dayBeforeTokens, weekAvgTokens };
  }

  /** Has today's daily report already been shown? */
  isDailyReportPending(): boolean {
    return this.state.lastDailyReportShownOn !== todayKey();
  }

  /** Mark today's report as shown so we don't fire it again. */
  markDailyReportShown(): void {
    this.state.lastDailyReportShownOn = todayKey();
    this.scheduleWrite();
  }

  /**
   * Aggregate everything the weekly card needs. The card UI must not do its
   * own math — that way the same numbers show up here and in any future
   * "current week" bubble.
   */
  computeWeeklyReport(now: Date = new Date()): WeeklyReport {
    const thisWeek = weekRange(now);
    const lastWeekAnchor = new Date(now);
    lastWeekAnchor.setDate(now.getDate() - 7);
    const lastWeek = weekRange(lastWeekAnchor);

    const daily: WeeklyDayBucket[] = thisWeek.map((date, i) => {
      const dateKey = formatDateKey(date);
      return {
        weekday: WEEKDAY_LABELS[i]!,
        dateKey,
        tokens: this.state.tokens.daily[dateKey] ?? 0,
      };
    });

    const thisWeekTokens = daily.reduce((s, d) => s + d.tokens, 0);
    const lastWeekTokens = lastWeek.reduce(
      (s, date) => s + (this.state.tokens.daily[formatDateKey(date)] ?? 0),
      0,
    );

    const changePct = lastWeekTokens > 0
      ? (thisWeekTokens - lastWeekTokens) / lastWeekTokens
      : null;

    const fedDays = daily.filter((d) => d.tokens > 0).length;

    // Streak: consecutive fed days ending today. If today is still empty
    // (early morning), look back from yesterday so we don't surprise the
    // user with a broken streak before they've even opened the editor.
    let streak = 0;
    const todayHasFed = (this.state.tokens.daily[todayKey()] ?? 0) > 0;
    for (let i = todayHasFed ? 0 : 1; i < 60; i++) {
      if ((this.state.tokens.daily[dayKeyOffset(i)] ?? 0) > 0) streak++;
      else break;
    }

    const peakDay = daily.reduce<WeeklyDayBucket | null>((best, d) => {
      if (d.tokens <= 0) return best;
      if (!best || d.tokens > best.tokens) return d;
      return best;
    }, null);

    const { year, week } = isoWeek(now);
    const level = computeLevel(this.state.tokens.cumulative);
    const nextRankTokensAway = level.nextThreshold !== null
      ? Math.max(0, level.nextThreshold - this.state.tokens.cumulative)
      : null;
    const nextLevelLabel = levelBadgeAt(level.index + 1);

    return {
      weekNumber: week,
      year,
      weekStart: formatDateKey(thisWeek[0]!),
      weekEnd: formatDateKey(thisWeek[6]!),
      daily,
      thisWeekTokens,
      lastWeekTokens,
      changePct,
      peakDay,
      fedDays,
      streak,
      level,
      nextLevelLabel,
      nextRankTokensAway,
      petName: this.state.settings.petName,
      uptimeMs: this.state.startedAt > 0 ? Math.max(0, now.getTime() - this.state.startedAt) : 0,
    };
  }

  getPetName(): string {
    return this.state.settings.petName;
  }

  setPetName(name: string): NomSettings {
    const trimmed = (name ?? '').trim().slice(0, 24);
    if (trimmed.length === 0) return this.getSettings();
    this.state.settings.petName = trimmed;
    this.scheduleWrite();
    return this.getSettings();
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

  setAutonomy(patch: Partial<AutonomySettings>): NomSettings {
    this.state.settings.autonomy = parseAutonomy({ ...this.state.settings.autonomy, ...patch });
    this.scheduleWrite();
    return this.getSettings();
  }

  isOnboarded(): boolean {
    return this.state.settings.onboarded;
  }

  /**
   * Persist the user's first-launch choices atomically. Marks onboarding
   * complete only after both name and kernel are validated.
   */
  completeOnboarding(petName: string, kernel: SoulKernel): NomSettings {
    const trimmedName = (petName ?? '').trim().slice(0, 24);
    if (trimmedName.length === 0) return this.getSettings();
    const trimmedKernel: SoulKernel = {
      preset: kernel.preset,
      text: kernel.text.trim().slice(0, 200),
    };
    if (trimmedKernel.text.length === 0) return this.getSettings();
    this.state.settings.petName = trimmedName;
    this.state.settings.soulKernel = trimmedKernel;
    this.state.settings.onboarded = true;
    this.scheduleWrite();
    return this.getSettings();
  }

  setSoulKernel(kernel: SoulKernel | null): NomSettings {
    if (kernel == null) {
      this.state.settings.soulKernel = null;
    } else {
      this.state.settings.soulKernel = {
        preset: kernel.preset,
        text: kernel.text.trim().slice(0, 200),
      };
    }
    this.scheduleWrite();
    return this.getSettings();
  }

  /**
   * Apply a today-baseline from history scan. Only updates today's slot
   * (does NOT touch cumulative — cumulative is live-only). Uses Math.max
   * so we never lose tokens already counted live this session.
   */
  setTodayBaseline(amount: number): StateSnapshot {
    return this.setDayBaseline(todayKey(), amount);
  }

  /**
   * Same as setTodayBaseline but for an arbitrary date key. Used by the
   * recent-history scan that backfills the daily map on startup so the
   * daily-recap bubble has yesterday's data even on first launch after
   * install.
   */
  setDayBaseline(dateKey: string, amount: number): StateSnapshot {
    if (amount > 0) {
      this.state.tokens.daily[dateKey] = Math.max(this.state.tokens.daily[dateKey] ?? 0, amount);
      this.pruneDaily();
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
