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

export interface TokensEvent {
  delta: number;
  source: 'claude-code';
  timestamp: number;
  snapshot: StateSnapshot;
}

export interface SessionEvent {
  source: 'claude-code';
  sessionId: string;
  kind: 'start';
  timestamp: number;
}

export interface ThinkingEvent {
  source: 'claude-code';
  sessionId: string;
  kind: 'start' | 'end';
  timestamp: number;
}

export interface NomSettings {
  wanderEnabled: boolean;
  activePetSlug: string | null;
}

export interface InstalledPetInfo {
  slug: string;
  displayName: string;
}
