export interface StateSnapshot {
  cumulative: number;
  today: number;
}

export interface PetStateConfig {
  frames: number[];
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
}

export type DialogueTrigger =
  | 'session-start'
  | 'milestone'
  | 'eating'
  | 'idle-click'
  | 'wake';

export interface DialogueContext {
  trigger: DialogueTrigger;
  todayTokens?: number;
  delta?: number;
  amount?: number;
  hour: number;        // 0–23
}

export interface InstalledPetInfo {
  slug: string;
  displayName: string;
}
