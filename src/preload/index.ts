import { contextBridge, ipcRenderer } from 'electron';
import type { DailyReport, DialogueContext, InstalledPetInfo, LevelInfo, LevelUpEvent, LlmSettings, LoadedPet, NomSettings, SessionEvent, StateSnapshot, ThinkingEvent, TokensEvent, WeeklyCardExportResult, WeeklyCardPayload, WeeklyCardStyle } from '../shared/types';

const api = {
  version: '0.0.21',
  getState(): Promise<StateSnapshot> {
    return ipcRenderer.invoke('nom:state:get') as Promise<StateSnapshot>;
  },
  getUserPet(): Promise<LoadedPet | null> {
    return ipcRenderer.invoke('nom:pet:get') as Promise<LoadedPet | null>;
  },
  onTokens(callback: (event: TokensEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, event: TokensEvent) => callback(event);
    ipcRenderer.on('nom:tokens', listener);
    return () => {
      ipcRenderer.removeListener('nom:tokens', listener);
    };
  },
  onSession(callback: (event: SessionEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, event: SessionEvent) => callback(event);
    ipcRenderer.on('nom:session', listener);
    return () => {
      ipcRenderer.removeListener('nom:session', listener);
    };
  },
  onThinking(callback: (event: ThinkingEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, event: ThinkingEvent) => callback(event);
    ipcRenderer.on('nom:thinking', listener);
    return () => {
      ipcRenderer.removeListener('nom:thinking', listener);
    };
  },
  dragBegin(screenX: number, screenY: number): void {
    ipcRenderer.send('nom:drag:begin', { x: screenX, y: screenY });
  },
  dragMove(screenX: number, screenY: number): void {
    ipcRenderer.send('nom:drag:move', { x: screenX, y: screenY });
  },
  dragEnd(): void {
    ipcRenderer.send('nom:drag:end');
  },
  getWindowBounds(): Promise<{
    win: { x: number; y: number; w: number; h: number };
    workArea: { x: number; y: number; width: number; height: number };
  } | null> {
    return ipcRenderer.invoke('nom:window:bounds');
  },
  moveWindowTo(x: number, y: number): void {
    ipcRenderer.send('nom:window:moveTo', { x, y });
  },
  getSettings(): Promise<NomSettings> {
    return ipcRenderer.invoke('nom:settings:get') as Promise<NomSettings>;
  },
  onSettingsChanged(callback: (settings: NomSettings) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, settings: NomSettings) => callback(settings);
    ipcRenderer.on('nom:settings:changed', listener);
    return () => {
      ipcRenderer.removeListener('nom:settings:changed', listener);
    };
  },
  listPets(): Promise<InstalledPetInfo[]> {
    return ipcRenderer.invoke('nom:pets:list') as Promise<InstalledPetInfo[]>;
  },
  onPetChanged(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on('nom:pet:changed', listener);
    return () => {
      ipcRenderer.removeListener('nom:pet:changed', listener);
    };
  },
  getDialogueLine(ctx: DialogueContext): Promise<string | null> {
    return ipcRenderer.invoke('nom:dialogue:line', ctx) as Promise<string | null>;
  },
  getLevel(): Promise<LevelInfo> {
    return ipcRenderer.invoke('nom:level:get') as Promise<LevelInfo>;
  },
  onLevelUp(callback: (event: LevelUpEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, event: LevelUpEvent) => callback(event);
    ipcRenderer.on('nom:level:up', listener);
    return () => {
      ipcRenderer.removeListener('nom:level:up', listener);
    };
  },
  setWanderEnabled(enabled: boolean): Promise<NomSettings> {
    return ipcRenderer.invoke('nom:settings:setWander', enabled) as Promise<NomSettings>;
  },
  setSourceEnabled(source: 'claudeCode' | 'codex', enabled: boolean): Promise<NomSettings> {
    return ipcRenderer.invoke('nom:settings:setSource', { source, enabled }) as Promise<NomSettings>;
  },
  setLlmSettings(llm: LlmSettings | null): Promise<NomSettings> {
    return ipcRenderer.invoke('nom:settings:setLlm', llm) as Promise<NomSettings>;
  },
  testLlm(llm: LlmSettings): Promise<{ ok: boolean; ms: number; error?: string; sample?: string }> {
    return ipcRenderer.invoke('nom:llm:test', llm);
  },
  getDailyReport(): Promise<{ pending: boolean; report: DailyReport | null }> {
    return ipcRenderer.invoke('nom:report:get') as Promise<{ pending: boolean; report: DailyReport | null }>;
  },
  markDailyReportShown(): Promise<void> {
    return ipcRenderer.invoke('nom:report:markShown') as Promise<void>;
  },
  exportWeeklyCard(style: WeeklyCardStyle): Promise<WeeklyCardExportResult> {
    return ipcRenderer.invoke('nom:report:exportWeekly', style) as Promise<WeeklyCardExportResult>;
  },
  // Used inside the card renderer only: pull the pre-staged payload that
  // the main process queued before opening the card window.
  getCardPayload(): Promise<WeeklyCardPayload | null> {
    return ipcRenderer.invoke('nom:card:getPayload') as Promise<WeeklyCardPayload | null>;
  },
  // Card renderer signals "I've painted the final frame, you can screenshot".
  cardReady(): void {
    ipcRenderer.send('nom:card:ready');
  },
};

contextBridge.exposeInMainWorld('nom', api);

export type NomApi = typeof api;
