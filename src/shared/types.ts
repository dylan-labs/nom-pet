export interface StateSnapshot {
  cumulative: number;
  today: number;
}

export interface PetStateConfig {
  frames: number[];
  /**
   * Optional left-facing frame indexes. When present, the renderer uses
   * these directly when facing left (rather than CSS-flipping `frames`).
   * Per petdex spec: row 1 is running-right and row 2 is running-left;
   * single-direction (native) packs that only draw one row may omit this
   * field and the renderer falls back to `scaleX(-1)`.
   */
  framesLeft?: number[];
  fps: number;
}

export interface PetConfig {
  id: string;
  name: string;
  description?: string;
  credit?: string;
  license?: string;
  spritesheet: string;
  frame: { width: number; height: number; cols: number };
  displayScale?: number;
  states: Record<string, PetStateConfig>;
}

export interface LoadedPet {
  slug: string;
  config: PetConfig;
  spritesheetDataUrl: string;
}

export type SourceId = 'claude-code' | 'codex';

export interface TokensEvent {
  delta: number;
  source: SourceId;
  timestamp: number;
  snapshot: StateSnapshot;
}

export interface SessionEvent {
  source: SourceId;
  sessionId: string;
  kind: 'start';
  timestamp: number;
}

export interface ThinkingEvent {
  source: SourceId;
  sessionId: string;
  kind: 'start' | 'end';
  timestamp: number;
}

export interface LevelInfo {
  index: number;
  tier: string;
  subLevel: string | null;
  badge: string;
  threshold: number;
  nextThreshold: number | null;
  progress: number;
  isTierStart: boolean;
}

export interface LevelUpEvent {
  from: LevelInfo;
  to: LevelInfo;
  tierJumped: boolean;       // crossed into a new big tier (新手 → 学徒 etc)
  cumulative: number;
}

/**
 * Pushed when the renderer should silently re-render its count + level.
 * Two reasons today:
 *  - 'lifetime-scan': background scan rebuilt cumulative from transcripts
 *  - 'source-toggle': user toggled Claude Code / Codex on or off, so the
 *    "today" total needs to re-filter against the new enabled set
 * Either way the renderer updates numbers without bubbles or animations.
 */
export interface StateReconciledEvent {
  snapshot: StateSnapshot;
  level: LevelInfo;
  reason: 'lifetime-scan' | 'source-toggle';
}

export interface SourceSettings {
  claudeCode: boolean;
  codex: boolean;
}

export interface LlmSettings {
  enabled: boolean;
  endpoint: string;       // OpenAI-compatible chat-completions URL
  model: string;
  apiKey: string | null;  // null for endpoints that don't need auth
}

export type SoulPreset =
  | 'tsundere-architect'
  | 'old-tcm-doctor'
  | 'tang-concubine'
  | 'cursed-doll'
  | 'aloof-otaku'
  | 'philosopher-stray'
  | 'custom';

export interface SoulKernel {
  preset: SoulPreset;
  /**
   * Personality text injected into every LLM system prompt. For built-in
   * presets this is the preset's canonical text (kept here so the kernel
   * is self-contained even if preset definitions evolve). For 'custom',
   * the user's own writing — hard-capped at 200 chars.
   */
  text: string;
}

/**
 * Toggles that control the autonomous-pet feature (The Tick + Pet Mind).
 * Master switch is OFF by default — the user has to opt in after reading
 * the privacy disclosure, because turning this on sends additional
 * context (mood + recent pet-mind notes) to the configured LLM.
 */
export interface AutonomySettings {
  enabled: boolean;
  /** Minutes between tick decisions. Spec default 30, allowed range 15–90. */
  tickIntervalMin: number;
  /** Hard daily cap on unprompted speak bubbles, to prevent the chatty-pet uninstall pattern. */
  maxBubblesPerDay: number;
  /** Whether the pet is allowed to occasionally ask the user a question (Phase 3). */
  allowAskMode: boolean;
}

/**
 * Five-state mood drift. Stays mostly sticky (≥60% chance unchanged per
 * tick) but slowly shifts in response to time-of-day, idle duration, and
 * the user's intake rhythm. Tints every LLM call via composeSystemPrompt
 * — it's potential-text, not a UI indicator, so the change reads as
 * "today my pet feels off" rather than an explicit RPG mood meter.
 */
export type Mood = 'vivacious' | 'normal' | 'pensive' | 'cranky' | 'withdrawn';

/**
 * Persisted mood state — current value + when it last moved + a short
 * audit trail. The reason field flows into the Settings "透明度" widget
 * (Phase 3) so users can see WHY their pet went moody.
 */
export interface MoodState {
  current: Mood;
  shiftedAt: string;          // ISO timestamp of last drift
  reason: string;             // short human-readable cause
  recent: Array<{
    from: Mood;
    to: Mood;
    at: string;
    reason: string;
  }>;
}

/**
 * One entry in the pet's private notebook (`~/.nom/pet-mind/notes.jsonl`).
 * The LLM appends these on each tick; on subsequent ticks they form
 * context, giving the pet apparent continuity across sessions.
 * Users CAN read this file — privacy by transparency, not by hiding.
 */
export interface PetMindNote {
  ts: string;                                    // ISO
  mood: Mood;
  kind: 'observation' | 'opinion' | 'self' | 'dream';
  text: string;                                  // ≤ 200 chars typically
}

/**
 * Tracks how long the user has been away (no token events). Read when
 * a token finally lands to decide whether to fire a "you were gone for
 * X hours" reaction. `longestGap` is for flavour — pet might reference
 * its personal "longest separation" in a future bubble.
 */
export interface AbsenceRecord {
  lastActiveAt: string | null;
  longestGap: { hours: number; endedAt: string } | null;
}

/** What happened on the most recent tick — surfaced by the transparency widget. */
export interface LastTickRecord {
  at: string;
  decision: 'silent' | 'observation' | 'speak' | 'mood_shift' | 'ask' | 'note' | 'dream';
}

export interface NomSettings {
  wanderEnabled: boolean;
  activePetSlug: string | null;
  llm: LlmSettings | null;
  sources: SourceSettings;
  petName: string;
  /** Has the user completed the first-launch onboarding (name + soul)? */
  onboarded: boolean;
  /** Pet personality. null until onboarding is done. */
  soulKernel: SoulKernel | null;
  /** Autonomous-pet feature toggles (v0.0.25+). */
  autonomy: AutonomySettings;
}

export type DialogueTrigger =
  | 'session-start'
  | 'milestone'
  | 'eating'
  | 'idle-click'
  | 'wake'
  | 'level-up'
  | 'daily-report';

export interface DailyReport {
  yesterdayKey: string;        // e.g. "2026-05-08"
  yesterdayTokens: number;
  dayBeforeTokens: number;
  weekAvgTokens: number;
}

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface WeeklyDayBucket {
  weekday: Weekday;
  dateKey: string;
  tokens: number;
}

export interface WeeklyReport {
  weekNumber: number;          // ISO week, 1..53
  year: number;                // ISO week-year
  weekStart: string;           // Monday YYYY-MM-DD
  weekEnd: string;             // Sunday YYYY-MM-DD
  daily: WeeklyDayBucket[];    // length 7, Mon..Sun
  thisWeekTokens: number;
  lastWeekTokens: number;
  changePct: number | null;    // (this-last)/last, null if last week was 0
  peakDay: WeeklyDayBucket | null;
  fedDays: number;             // days this week with tokens > 0 (0..7)
  streak: number;              // consecutive fed days ending today
  level: LevelInfo;
  nextLevelLabel: string | null;  // e.g. "行家 III", or null at max rank
  nextRankTokensAway: number | null;
  petName: string;
  uptimeMs: number;               // since first install (state.startedAt)
}

export interface DialogueContext {
  trigger: DialogueTrigger;
  todayTokens?: number;
  delta?: number;
  amount?: number;
  hour: number;          // 0–23
  level?: LevelInfo;     // current pet level (passed when relevant for flavour)
  levelUp?: LevelUpEvent;
  report?: DailyReport;  // populated for trigger === 'daily-report'
  /** Pet's chosen name. Injected by main process from settings. */
  petName?: string;
  /**
   * Minutes since the last token event (any source) was observed in this
   * session. Injected by main process. null/undefined = no feeding yet
   * since launch.
   */
  minutesSinceLastFed?: number | null;
}

export interface InstalledPetInfo {
  slug: string;
  displayName: string;
}

export type WeeklyCardStyle = 'gameboy' | 'terminal';

export interface WeeklyCardPayload {
  style: WeeklyCardStyle;
  report: WeeklyReport;
}

export interface WeeklyCardExportResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/**
 * The numbers we feed the journal generator. Kept qualitative-friendly:
 * the LLM is told to never recite raw figures, so we also pre-bucket them
 * in the prompt. Mood is derived from this in the template fallback.
 */
export interface JournalDailyMetadata {
  dateKey: string;             // YYYY-MM-DD
  weekday: Weekday;
  yesterdayTokens: number;
  dayBeforeTokens: number;     // 0 if no data
  weekAvgTokens: number;       // 0 if no data
  /** Cumulative-thousand-thresholds crossed yesterday (e.g. 50000, 100000). */
  milestonesCrossed: number[];
}

/**
 * Pushed to the pet window when a fresh journal lands on disk. Renderer
 * uses this to show a 3s "昨天的日记写完了" bubble — the gentle nudge
 * that turns the otherwise-silent background write into a visible
 * artifact the user might actually open.
 */
export interface JournalCreatedEvent {
  dateKey: string;             // YYYY-MM-DD that was just written
  generatedBy: 'llm' | 'template';
}

/**
 * Frontmatter + body of one journal day. Persisted as Markdown but kept
 * structured in-memory for the viewer / IPC layer. `body` does NOT
 * include the frontmatter delimiters.
 */
export interface JournalEntry {
  date: string;                // YYYY-MM-DD
  weekday: Weekday;
  weather: string;             // single emoji, e.g. '☔'
  body: string;                // already trimmed prose, 80-200 chars
  generatedBy: 'llm' | 'template';
  petName: string;
  soulKernelPreset: SoulPreset | null;
  generatedAt: string;         // ISO-8601
  /** Raw metadata that fed the generator. Useful for re-generation + debugging. */
  metadata: JournalDailyMetadata;
}
