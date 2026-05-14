import { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut, clipboard, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { ClaudeSource } from './data/claude-source';
import { CodexSource } from './data/codex-source';
import { Store, type WindowPosition } from './data/store';
import { scanRecentHistory, scanLifetimeHistory } from './data/today-scan';
import { scanCodexRecentHistory, scanCodexLifetimeHistory } from './data/codex-today-scan';
import { loadUserPet, listInstalledPets } from './data/pet-loader';
import { generateLine, testLlm } from './data/llm';
import { generateJournalForYesterday, listJournalDates, readJournal, regenerateJournal } from './data/journal';
import type { DailyReport, DialogueContext, JournalCreatedEvent, JournalEntry, LevelInfo, LevelUpEvent, LlmSettings, NomSettings, SessionEvent, SoulKernel, SoulPreset, SourceId, StateReconciledEvent, StateSnapshot, ThinkingEvent, TokensEvent, WeeklyCardExportResult, WeeklyCardPayload, WeeklyCardStyle } from '../shared/types';
import { presetText } from './data/soul';

const WIN_SIZE = 200;
const MOVE_DEBOUNCE_MS = 400;
const SUMMON_SHORTCUT = 'CommandOrControl+Alt+N';

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let cardWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let journalWindow: BrowserWindow | null = null;
// Staged for the card renderer to pull via IPC once the window opens. Lives
// here (not in Store) because it's an in-flight UI payload, not persistent state.
let pendingCardPayload: WeeklyCardPayload | null = null;
const claudeSource = new ClaudeSource();
const codexSource = new CodexSource();
const store = new Store();
// In-memory only — used to flavour LLM dialogue ("you haven't fed me in 20
// minutes"). Reset on launch by design: persisting would let cross-session
// gaps leak in, which makes no sense ("you haven't fed me in 3 days").
let lastFedAt: number | null = null;

/**
 * Reconcile source watchers with the current settings — start the ones that
 * are enabled and not running, stop the ones that are running but disabled.
 * Called on boot and after every settings change.
 */
function reconcileSources(): void {
  const s = store.getSettings().sources;
  if (s.claudeCode) claudeSource.start(); else claudeSource.stop();
  if (s.codex)      codexSource.start();  else codexSource.stop();
}

/**
 * Background self-heal: sweep every Claude + Codex transcript and use the
 * lifetime weighted total as a floor for `cumulative`. If the user deleted
 * `~/.nom/state.json` (or it got corrupted), their level reappears within
 * a few seconds of next launch instead of disappearing forever.
 *
 * Fire-and-forget — never blocks the pet window. The cumulative bump and
 * any backfilled daily buckets are pushed to the renderer via
 * `nom:state:reconciled` if the pet window already exists; otherwise the
 * renderer will pick the new values up via its mount-time `getState()` /
 * `getLevel()` queries (e.g. after onboarding completes).
 */
/**
 * Close the off-window gap when the user re-enables a source. While the
 * watcher was stopped, any tokens the user actually consumed are sitting
 * in the JSONL on disk but were never emitted as live events; the
 * watcher's restart then sets its offsets past those events. We re-scan
 * today's transcripts for that source and push the missed delta into
 * `todayBySource` + cumulative + daily. Math.max inside the store
 * guarantees idempotence and never shrinks anything.
 */
async function backfillSourceAfterEnable(uiKey: 'claudeCode' | 'codex'): Promise<void> {
  try {
    const todayK = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const source: SourceId = uiKey === 'claudeCode' ? 'claude-code' : 'codex';
    const scan = uiKey === 'claudeCode'
      ? await scanRecentHistory(1)
      : await scanCodexRecentHistory(1);
    const amount = scan.perDay[todayK] ?? 0;
    if (amount <= 0) return;
    const { bumpedCumulative } = store.backfillSourceToday(source, amount);
    if (bumpedCumulative > 0) {
      console.log(
        `[nom] re-enable backfill for ${source}: caught up ${bumpedCumulative} ` +
        `tokens missed while watcher was off`
      );
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('nom:state:reconciled', {
          snapshot: store.snapshot(),
          level: store.getLevel(),
          reason: 'source-toggle',
        } satisfies StateReconciledEvent);
      }
    }
  } catch (err) {
    console.error('[nom] re-enable backfill failed:', err);
  }
}

async function runLifetimeReconcile(): Promise<void> {
  try {
    const [claude, codex] = await Promise.all([
      scanLifetimeHistory(),
      scanCodexLifetimeHistory(),
    ]);
    // Backfill any pre-7-day-window dates the recent scan didn't cover.
    // setDayBaseline uses Math.max, so this never decreases an existing
    // count — safe to call for every day we see.
    const allDays = new Set<string>([
      ...Object.keys(claude.perDay),
      ...Object.keys(codex.perDay),
    ]);
    for (const day of allDays) {
      const combined = (claude.perDay[day] ?? 0) + (codex.perDay[day] ?? 0);
      store.setDayBaseline(day, combined);
    }
    // Mirror the recent-scan path: also seed today's per-source bucket
    // so the source-filter view shows the correct subtotal even on
    // first launch with no live events yet.
    const todayK = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    if (claude.perDay[todayK]) store.setTodayBaselineForSource('claude-code', claude.perDay[todayK]);
    if (codex.perDay[todayK])  store.setTodayBaselineForSource('codex',       codex.perDay[todayK]);
    const lifetimeTotal = claude.total + codex.total;
    const { changed, snapshot, level } = store.reconcileCumulativeFloor(lifetimeTotal);
    if (changed) {
      console.log(
        `[nom] lifetime reconcile bumped cumulative → ${snapshot.cumulative} ` +
        `(claude=${claude.filesScanned}f/${claude.total}, codex=${codex.filesScanned}f/${codex.total})`
      );
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('nom:state:reconciled', {
          snapshot, level, reason: 'lifetime-scan',
        } satisfies StateReconciledEvent);
      }
    } else {
      console.log(
        `[nom] lifetime reconcile: cumulative already ≥ lifetime total ` +
        `(${snapshot.cumulative} vs ${lifetimeTotal}); no change`
      );
    }
  } catch (err) {
    console.error('[nom] lifetime reconcile failed:', err);
  }
}


// --- Single-instance lock --------------------------------------------------
// If another nom is already running, exit immediately and tell the existing
// instance to come back to the user's current screen.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    bringToCurrentScreen();
  });
  void main();
}

// --- Position helpers ------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function currentDisplay(): Electron.Display {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

function defaultPositionFor(display: Electron.Display): { x: number; y: number; displayId: number } {
  const { width, height } = display.workAreaSize;
  return {
    x: display.bounds.x + width - WIN_SIZE - 32,
    y: display.bounds.y + height - WIN_SIZE - 32,
    displayId: display.id,
  };
}

/**
 * Restore the saved position only if it lives on the user's current screen
 * (cursor screen). Otherwise place the pet at the bottom-right of where the
 * cursor is — pet always shows up where the user is actually looking.
 */
function pickInitialPosition(): { x: number; y: number; displayId: number } {
  const cursor = currentDisplay();
  const stored = store.getWindowPosition();

  if (stored && stored.displayId === cursor.id) {
    const { x, y, width, height } = cursor.bounds;
    return {
      x: clamp(stored.x, x, x + width - WIN_SIZE),
      y: clamp(stored.y, y, y + height - WIN_SIZE),
      displayId: cursor.id,
    };
  }
  return defaultPositionFor(cursor);
}

function bringToCurrentScreen(): void {
  if (!petWindow) return;
  const target = defaultPositionFor(currentDisplay());
  petWindow.setPosition(target.x, target.y);
  petWindow.show();
  petWindow.focus();
}

// --- Window ----------------------------------------------------------------

function createPetWindow() {
  const { x, y } = pickInitialPosition();

  petWindow = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    x,
    y,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  petWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  petWindow.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moveTimer = null;
      if (!petWindow) return;
      const [px, py] = petWindow.getPosition();
      const display = screen.getDisplayMatching(petWindow.getBounds());
      const pos: WindowPosition = { x: px, y: py, displayId: display.id };
      store.setWindowPosition(pos);
    }, MOVE_DEBOUNCE_MS);
  });

  petWindow.webContents.on('context-menu', async () => {
    if (!petWindow) return;
    const settings = store.getSettings();
    const installed = await listInstalledPets();
    const weekly = store.computeWeeklyReport();
    const canExportCard = weekly.thisWeekTokens > 0;

    // "切换宠物" submenu is ALWAYS present so users with zero pets still
    // have a path to install more (otherwise they'd never discover the
    // feature exists). Layout:
    //   - 0 pets: a disabled "（未安装宠物）" item explaining the state
    //   - 1+ pets: radios for each, current one checked
    //   - Always: separator + "打开宠物文件夹" so the user has somewhere
    //             to drop new PetDex packs without hunting for the path.
    const petsDir = path.join(os.homedir(), '.codex', 'pets');
    const petSubmenu: Electron.MenuItemConstructorOptions[] = installed.length === 0
      ? [{ label: '（未安装宠物）', enabled: false }]
      : installed.map((p) => ({
          label: p.displayName,
          type: 'radio' as const,
          checked: (settings.activePetSlug ?? installed[0]!.slug) === p.slug,
          click: () => {
            store.setActivePetSlug(p.slug);
            petWindow?.webContents.send('nom:pet:changed');
          },
        }));
    petSubmenu.push(
      { type: 'separator' },
      {
        label: '📁  打开宠物文件夹',
        click: async () => {
          // Create on demand so first-time users don't get a "no such
          // directory" error — they just see an empty Finder window
          // where they can drop packs.
          try { await fs.mkdir(petsDir, { recursive: true }); } catch { /* ignore */ }
          void shell.openPath(petsDir);
        },
      },
    );

    // Build top-level items. Toggles (游走 / AI 台词 / 数据源) used to
    // live here too — they're now Settings-only because the right-click
    // menu reads better as "destinations" than as a kitchen-sink panel.
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: '📓  翻日记本',
        click: () => openJournalWindow(),
      },
      {
        label: '🃏  导出战绩',
        enabled: canExportCard,
        submenu: [
          {
            label: 'Game Boy 风',
            click: () => { void exportWeeklyCard('gameboy'); },
          },
          {
            label: '极客风 · Hacker Mode',
            click: () => { void exportWeeklyCard('terminal'); },
          },
        ],
      },
    ];
    items.push({ label: '🐾  切换宠物', submenu: petSubmenu });
    items.push(
      { type: 'separator' },
      { label: '⚙️  设置', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
      { label: '👋  让它休息', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    );

    Menu.buildFromTemplate(items).popup({ window: petWindow });
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    petWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Render the weekly card in an off-screen 1080×1080 BrowserWindow, capture
 * the page as a PNG, save to ~/Desktop and copy to clipboard.
 *
 * The card window pulls its data via IPC (`nom:card:getPayload`) once it
 * mounts, then signals back with `nom:card:ready` after painting — only
 * then do we capturePage, so we don't catch an unstyled flash.
 */
async function exportWeeklyCard(style: WeeklyCardStyle): Promise<WeeklyCardExportResult> {
  if (cardWindow && !cardWindow.isDestroyed()) {
    return { ok: false, error: '上一张战绩卡还在导出中,稍等一下' };
  }

  const report = store.computeWeeklyReport();
  if (report.thisWeekTokens <= 0) {
    return { ok: false, error: '本周还没吃到 token,卡片没东西可写' };
  }

  pendingCardPayload = { style, report };

  cardWindow = new BrowserWindow({
    width: 1080,
    height: 1080,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const cardUrl = process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}/card.html?style=${style}`
    : `file://${path.join(__dirname, '../renderer/card.html')}?style=${style}`;

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('nom:card:ready', handler);
      reject(new Error('战绩卡渲染超时(>8s)'));
    }, 8000);
    const handler = (event: Electron.IpcMainEvent) => {
      if (event.sender === cardWindow?.webContents) {
        clearTimeout(timeout);
        ipcMain.removeListener('nom:card:ready', handler);
        resolve();
      }
    };
    ipcMain.on('nom:card:ready', handler);
  });

  try {
    await cardWindow.loadURL(cardUrl);
    await readyPromise;

    const image = await cardWindow.webContents.capturePage();
    const png = image.toPNG();
    const filename = `nom-WK${String(report.weekNumber).padStart(2, '0')}-${report.year}-${style}.png`;
    const filePath = path.join(app.getPath('desktop'), filename);
    await fs.writeFile(filePath, png);
    clipboard.writeImage(image);
    shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[nom] export weekly card failed:', err);
    dialog.showErrorBox('nom · 导出失败', msg);
    return { ok: false, error: msg };
  } finally {
    pendingCardPayload = null;
    if (cardWindow && !cardWindow.isDestroyed()) cardWindow.destroy();
    cardWindow = null;
  }
}

/**
 * Open the Game Boy-styled journal viewer. Singleton — clicking the
 * menu item again brings the existing window forward instead of opening
 * a second copy.
 */
function openJournalWindow(): void {
  if (journalWindow && !journalWindow.isDestroyed()) {
    journalWindow.show();
    journalWindow.focus();
    return;
  }

  journalWindow = new BrowserWindow({
    width: 420,
    height: 600,
    title: 'nom · 日记本',
    // Frameless + matte-black bg so the renderer fully owns the look —
    // shell, screen, D-pad and A/B all drawn inside, matching the weekly
    // card's Game Boy device illustration. macOS traffic lights would
    // clash with the LCD aesthetic, hence frame: false.
    frame: false,
    backgroundColor: '#0a0a0a',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  journalWindow.once('ready-to-show', () => journalWindow?.show());
  journalWindow.on('closed', () => { journalWindow = null; });

  if (process.env['ELECTRON_RENDERER_URL']) {
    journalWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/journal.html`);
  } else {
    journalWindow.loadFile(path.join(__dirname, '../renderer/journal.html'));
  }
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 620,
    title: 'nom · 设置',
    backgroundColor: '#f5f5f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });

  if (process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`);
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  }
}

/**
 * Opens the first-launch onboarding window. Closing this window without
 * completing the flow (red X / Cmd-Q) quits the app — onboarding is mandatory
 * per spec §2.1.
 */
function openOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }

  onboardingWindow = new BrowserWindow({
    width: 460,
    height: 620,
    title: 'nom · 欢迎',
    backgroundColor: '#f5f5f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  onboardingWindow.once('ready-to-show', () => onboardingWindow?.show());
  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
    // If the user closed the window WITHOUT completing onboarding, quit.
    // Mandatory ritual: there's no "use Mochi by default" escape hatch.
    if (!store.isOnboarded()) {
      app.quit();
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    onboardingWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/onboarding.html`);
  } else {
    onboardingWindow.loadFile(path.join(__dirname, '../renderer/onboarding.html'));
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  await app.whenReady();

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  await store.load();

  try {
    const [claude, codex] = await Promise.all([
      scanRecentHistory(7),
      scanCodexRecentHistory(7),
    ]);
    // Merge per-day from both sources, then seed daily buckets. Math.max
    // inside setDayBaseline preserves any live-tracked counts already in
    // memory for those days (shouldn't happen on a fresh launch but is
    // the safe default).
    const allDays = new Set<string>([...Object.keys(claude.perDay), ...Object.keys(codex.perDay)]);
    let totalSeeded = 0;
    for (const day of allDays) {
      const combined = (claude.perDay[day] ?? 0) + (codex.perDay[day] ?? 0);
      store.setDayBaseline(day, combined);
      totalSeeded += combined;
    }
    // ALSO seed today's per-source bucket so toggling sources mid-day
    // immediately drops the "today" counter to the correct subtotal
    // — without this, the filter would read 0 for a source we haven't
    // received a live event from yet this session.
    const todayK = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    if (claude.perDay[todayK]) store.setTodayBaselineForSource('claude-code', claude.perDay[todayK]);
    if (codex.perDay[todayK])  store.setTodayBaselineForSource('codex',       codex.perDay[todayK]);
    console.log(
      `[nom] history scan seeded ${allDays.size} days, total ${totalSeeded} tokens ` +
      `(claude=${claude.filesScanned}f, codex=${codex.filesScanned}f)`
    );
  } catch (err) {
    console.error('[nom] history scan failed:', err);
  }

  // Self-healing recovery: lifetime sweep against the canonical transcript
  // files. Runs in the background so it never blocks the pet window — if
  // it finishes after the renderer is mounted, the result lands via
  // `nom:state:reconciled`; if before, the renderer's mount-time queries
  // pick up the fresh values.
  void runLifetimeReconcile();

  ipcMain.handle('nom:state:get', (): StateSnapshot => store.snapshot());
  ipcMain.handle('nom:level:get', (): LevelInfo => store.getLevel());
  ipcMain.handle('nom:pet:get', () => loadUserPet(store.getSettings().activePetSlug));
  ipcMain.handle('nom:pets:list', () => listInstalledPets());
  ipcMain.handle('nom:settings:get', (): NomSettings => store.getSettings());
  ipcMain.handle('nom:settings:setLlm', (_, llm: LlmSettings | null): NomSettings => {
    const next = store.setLlmSettings(llm);
    petWindow?.webContents.send('nom:settings:changed', next);
    return next;
  });
  ipcMain.handle('nom:settings:setWander', (_, enabled: boolean): NomSettings => {
    const next = store.setWanderEnabled(enabled);
    petWindow?.webContents.send('nom:settings:changed', next);
    return next;
  });
  ipcMain.handle('nom:settings:setSource', (_, args: { source: 'claudeCode' | 'codex'; enabled: boolean }): NomSettings => {
    const next = store.setSourceEnabled(args.source, args.enabled);
    reconcileSources();
    petWindow?.webContents.send('nom:settings:changed', next);
    // Toggling a source changes which buckets the "today" counter sums,
    // so push a fresh snapshot. The renderer's onStateReconciled handler
    // updates the visible number silently (no bubble).
    petWindow?.webContents.send('nom:state:reconciled', {
      snapshot: store.snapshot(),
      level: store.getLevel(),
      reason: 'source-toggle',
    } satisfies StateReconciledEvent);
    // When the source comes back ON, fire a fire-and-forget scan of
    // TODAY's transcripts for that source — closes the gap left by any
    // tool usage that happened while the watcher was stopped. Pushes a
    // second reconciled event if the scan actually bumped anything.
    if (args.enabled) {
      void backfillSourceAfterEnable(args.source);
    }
    return next;
  });
  ipcMain.handle('nom:settings:setName', (_, name: string): NomSettings => {
    const next = store.setPetName(name);
    petWindow?.webContents.send('nom:settings:changed', next);
    return next;
  });
  ipcMain.handle('nom:settings:setSoul', (_, kernel: SoulKernel | null): NomSettings => {
    const next = store.setSoulKernel(kernel);
    petWindow?.webContents.send('nom:settings:changed', next);
    return next;
  });
  // ── Onboarding ───────────────────────────────────────────────────────
  ipcMain.handle('nom:onboarding:isPending', (): boolean => !store.isOnboarded());
  ipcMain.handle('nom:onboarding:complete', (_, args: { petName: string; preset: SoulPreset; customText?: string }): NomSettings => {
    // Resolve the kernel text: preset → canonical; custom → user-supplied.
    let text: string;
    if (args.preset === 'custom') {
      text = (args.customText ?? '').trim();
    } else {
      text = presetText(args.preset) ?? '';
    }
    if (!text) {
      // Defensive: never let onboarding complete with an empty kernel.
      return store.getSettings();
    }
    const next = store.completeOnboarding(args.petName, { preset: args.preset, text });
    // Close the onboarding window now that state is persisted, and hand
    // off to the regular pet experience.
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    if (!petWindow || petWindow.isDestroyed()) {
      createPetWindow();
    }
    petWindow?.webContents.send('nom:settings:changed', next);
    return next;
  });
  ipcMain.handle('nom:llm:test', async (_, llm: LlmSettings): Promise<{ ok: boolean; ms: number; error?: string; sample?: string }> => {
    const settings = store.getSettings();
    const start = Date.now();
    const result = await testLlm({ ...llm, enabled: true }, settings.petName, settings.soulKernel);
    const ms = Date.now() - start;
    if (!result.ok) return { ok: false, ms, error: result.error };
    return { ok: true, ms, sample: result.sample };
  });
  ipcMain.handle('nom:dialogue:line', async (_, ctx: DialogueContext): Promise<string | null> => {
    const settings = store.getSettings();
    if (!settings.llm) return null;
    const enriched: DialogueContext = {
      ...ctx,
      petName: settings.petName,
      minutesSinceLastFed: lastFedAt == null ? null : Math.floor((Date.now() - lastFedAt) / 60000),
    };
    return generateLine(settings.llm, enriched, settings.soulKernel);
  });
  ipcMain.handle('nom:report:get', (): { pending: boolean; report: DailyReport | null } => ({
    pending: store.isDailyReportPending(),
    report: store.computeDailyReport(),
  }));
  ipcMain.handle('nom:report:markShown', (): void => store.markDailyReportShown());
  ipcMain.handle('nom:report:exportWeekly', (_, style: WeeklyCardStyle): Promise<WeeklyCardExportResult> => {
    return exportWeeklyCard(style);
  });
  ipcMain.handle('nom:card:getPayload', (): WeeklyCardPayload | null => pendingCardPayload);

  // ── Journal ──────────────────────────────────────────────────────────
  ipcMain.handle('nom:journal:list', (): Promise<string[]> => listJournalDates());
  ipcMain.handle('nom:journal:get', (_, dateKey: string): Promise<JournalEntry | null> => readJournal(dateKey));
  ipcMain.handle('nom:journal:regenerate', (_, dateKey: string): Promise<JournalEntry | null> => regenerateJournal(store, dateKey));
  // Renderer-triggered window open — lets the post-generation bubble's
  // click handler ask main to pop the viewer without re-implementing
  // window creation IPC for one button.
  ipcMain.on('nom:journal:open', () => openJournalWindow());

  let dragOrigin: { mouseX: number; mouseY: number; winX: number; winY: number } | null = null;
  ipcMain.on('nom:drag:begin', (_, { x, y }: { x: number; y: number }) => {
    if (!petWindow) return;
    const [winX, winY] = petWindow.getPosition();
    dragOrigin = { mouseX: x, mouseY: y, winX, winY };
  });
  ipcMain.on('nom:drag:move', (_, { x, y }: { x: number; y: number }) => {
    if (!petWindow || !dragOrigin) return;
    const dx = x - dragOrigin.mouseX;
    const dy = y - dragOrigin.mouseY;
    petWindow.setPosition(dragOrigin.winX + dx, dragOrigin.winY + dy);
  });
  ipcMain.on('nom:drag:end', () => {
    dragOrigin = null;
  });

  ipcMain.handle('nom:window:bounds', () => {
    if (!petWindow) return null;
    const [x, y] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const display = screen.getDisplayMatching(petWindow.getBounds());
    const wa = display.workArea;
    return {
      win: { x, y, w, h },
      workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
    };
  });
  ipcMain.on('nom:window:moveTo', (_, { x, y }: { x: number; y: number }) => {
    if (!petWindow) return;
    const display = screen.getDisplayMatching(petWindow.getBounds());
    const { x: ax, y: ay, width, height } = display.workArea;
    const [w, h] = petWindow.getSize();
    petWindow.setPosition(
      Math.max(ax, Math.min(Math.round(x), ax + width - w)),
      Math.max(ay, Math.min(Math.round(y), ay + height - h)),
    );
  });

  if (store.isOnboarded()) {
    createPetWindow();
  } else {
    openOnboardingWindow();
  }

  // 5 seconds after the pet window is up, try to write yesterday's
  // journal. Non-blocking, fully self-contained: bails when there's no
  // data for yesterday or the file already exists. LLM failures fall
  // back to the template path so the file always lands. On success, fan
  // a JournalCreatedEvent out to the pet renderer so it can pop a
  // "want to read it?" bubble — the visible hook that turns this from
  // a silent backend cron into something users notice.
  setTimeout(async () => {
    const entry = await generateJournalForYesterday(store);
    if (entry && petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('nom:journal:created', {
        dateKey: entry.date,
        generatedBy: entry.generatedBy,
      } satisfies JournalCreatedEvent);
    }
  }, 5000);

  // Global shortcut to summon the pet back to the current screen if it ends
  // up somewhere invisible (different display, full-screen app on top, etc).
  const ok = globalShortcut.register(SUMMON_SHORTCUT, bringToCurrentScreen);
  if (!ok) {
    console.log(`[nom] could not register global shortcut ${SUMMON_SHORTCUT} (already in use?)`);
  }

  // Both sources fan in to the same renderer events. Renderer doesn't
  // care which source it came from (dialogue stays unified per user
  // request); only the running token counter and animation react.
  function onTokens(event: { delta: number; source: SourceId; timestamp: number }) {
    const { snapshot, levelUp } = store.addTokens(event.delta, event.source);
    lastFedAt = event.timestamp;
    petWindow?.webContents.send('nom:tokens', { ...event, snapshot } satisfies TokensEvent);
    if (levelUp) {
      petWindow?.webContents.send('nom:level:up', levelUp);
    }
  }
  function onSession(event: SessionEvent) {
    petWindow?.webContents.send('nom:session', event);
  }
  claudeSource.on('tokens', onTokens);
  claudeSource.on('session', onSession);
  claudeSource.on('thinking', (event) => {
    // Codex doesn't emit thinking events yet — only Claude has the
    // user/assistant turn pattern that maps onto "agent is thinking now".
    const payload: ThinkingEvent = { ...event };
    petWindow?.webContents.send('nom:thinking', payload);
  });
  codexSource.on('tokens', onTokens);
  codexSource.on('session', onSession);
  reconcileSources();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
}

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    globalShortcut.unregisterAll();
    claudeSource.stop();
    codexSource.stop();
    await store.flush();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
