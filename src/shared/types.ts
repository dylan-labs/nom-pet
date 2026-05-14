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

export interface NomSettings {
  wanderEnabled: boolean;
  activePetSlug: string | null;
  llm: LlmSettings | null;
  sources: SourceSettings;
  petName: string;
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
