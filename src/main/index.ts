import { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import { ClaudeSource } from './data/claude-source';
import { Store, type WindowPosition } from './data/store';
import { scanTodayHistory } from './data/today-scan';
import { loadUserPet, listInstalledPets } from './data/pet-loader';
import type { NomSettings, SessionEvent, StateSnapshot, ThinkingEvent, TokensEvent } from '../shared/types';

const WIN_SIZE = 200;
const MOVE_DEBOUNCE_MS = 400;
const SUMMON_SHORTCUT = 'CommandOrControl+Alt+N';

let petWindow: BrowserWindow | null = null;
const claudeSource = new ClaudeSource();
const store = new Store();

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
      { label: '选择宠物', submenu: petSubmenu },
      { type: 'separator' },
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

// --- Main ------------------------------------------------------------------

async function main() {
  await app.whenReady();

  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  await store.load();

  try {
    const scan = await scanTodayHistory();
    store.setTodayBaseline(scan.tokens);
    console.log(`[nom] today baseline: ${scan.tokens} tokens from ${scan.filesScanned} files`);
  } catch (err) {
    console.error('[nom] today scan failed:', err);
  }

  ipcMain.handle('nom:state:get', (): StateSnapshot => store.snapshot());
  ipcMain.handle('nom:pet:get', () => loadUserPet(store.getSettings().activePetSlug));
  ipcMain.handle('nom:pets:list', () => listInstalledPets());
  ipcMain.handle('nom:settings:get', (): NomSettings => store.getSettings());

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

  claudeSource.on('tokens', (event) => {
    const snapshot = store.addTokens(event.delta);
    const payload: TokensEvent = { ...event, snapshot };
    petWindow?.webContents.send('nom:tokens', payload);
  });
  claudeSource.on('session', (event) => {
    const payload: SessionEvent = { ...event };
    petWindow?.webContents.send('nom:session', payload);
  });
  claudeSource.on('thinking', (event) => {
    const payload: ThinkingEvent = { ...event };
    petWindow?.webContents.send('nom:thinking', payload);
  });
  claudeSource.start();

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
    await store.flush();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
