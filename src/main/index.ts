import { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import { ClaudeSource } from './data/claude-source';
import { CodexSource } from './data/codex-source';
import { Store, type WindowPosition } from './data/store';
import { scanTodayHistory } from './data/today-scan';
import { scanCodexTodayHistory } from './data/codex-today-scan';
import { loadUserPet, listInstalledPets } from './data/pet-loader';
import { generateLine } from './data/llm';
import type { DialogueContext, LevelInfo, LevelUpEvent, LlmSettings, NomSettings, SessionEvent, SourceId, StateSnapshot, ThinkingEvent, TokensEvent } from '../shared/types';

const WIN_SIZE = 200;
const MOVE_DEBOUNCE_MS = 400;
const SUMMON_SHORTCUT = 'CommandOrControl+Alt+N';

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
const claudeSource = new ClaudeSource();
const codexSource = new CodexSource();
const store = new Store();

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

    const menu = Menu.buildFromTemplate([
      {
        label: '允许游走',
        type: 'checkbox',
        checked: settings.wanderEnabled,
        click: (item) => {
          const next = store.setWanderEnabled(item.checked);
          petWindow?.webContents.send('nom:settings:changed', next);
        },
      },
      {
        label: 'AI 台词',
        type: 'checkbox',
        checked: !!settings.llm?.enabled,
        click: (item) => {
          const next = store.setLlmEnabled(item.checked);
          petWindow?.webContents.send('nom:settings:changed', next);
        },
      },
      {
        label: '数据源',
        submenu: [
          {
            label: 'Claude Code',
            type: 'checkbox',
            checked: settings.sources.claudeCode,
            click: (item) => {
              const next = store.setSourceEnabled('claudeCode', item.checked);
              reconcileSources();
              petWindow?.webContents.send('nom:settings:changed', next);
            },
          },
          {
            label: 'Codex',
            type: 'checkbox',
            checked: settings.sources.codex,
            click: (item) => {
              const next = store.setSourceEnabled('codex', item.checked);
              reconcileSources();
              petWindow?.webContents.send('nom:settings:changed', next);
            },
          },
        ],
      },
      { label: '选择宠物', submenu: petSubmenu },
      { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
      { label: '关闭宠物', click: () => app.quit() },
    ]);
    menu.popup({ window: petWindow });
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    petWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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

// --- Main ------------------------------------------------------------------

async function main() {
  await app.whenReady();

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  await store.load();

  try {
    const [claude, codex] = await Promise.all([
      scanTodayHistory(),
      scanCodexTodayHistory(),
    ]);
    const total = claude.tokens + codex.tokens;
    store.setTodayBaseline(total);
    console.log(
      `[nom] today baseline: ${total} tokens ` +
      `(claude=${claude.tokens}/${claude.filesScanned}f, codex=${codex.tokens}/${codex.filesScanned}f)`
    );
  } catch (err) {
    console.error('[nom] today scan failed:', err);
  }

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
    return next;
  });
  ipcMain.handle('nom:llm:test', async (_, llm: LlmSettings): Promise<{ ok: boolean; ms: number; error?: string; sample?: string }> => {
    const start = Date.now();
    const result = await generateLine(
      { ...llm, enabled: true },
      { trigger: 'idle-click', hour: new Date().getHours() },
    );
    const ms = Date.now() - start;
    if (result == null) return { ok: false, ms, error: '调用失败：检查 endpoint / model / API key 是否正确' };
    return { ok: true, ms, sample: result };
  });
  ipcMain.handle('nom:dialogue:line', async (_, ctx: DialogueContext): Promise<string | null> => {
    const llm = store.getSettings().llm;
    if (!llm) return null;
    return generateLine(llm, ctx);
  });

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

  createPetWindow();

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
    const { snapshot, levelUp } = store.addTokens(event.delta);
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
