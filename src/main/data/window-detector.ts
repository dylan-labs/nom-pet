/**
 * Wraps the ESM-only `get-windows` package so the rest of nom can ask
 * "where are all the visible windows on screen right now?" — used by the
 * pet's wander logic to occasionally pick a real window's top edge as a
 * destination, Shimeji-style.
 *
 * Native binding is rebuilt for Electron via @electron/rebuild during
 * `npm run pack`.
 */

export interface VisibleWindow {
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// `get-windows` is ESM-only; main is compiled to CJS. Bypass TS's static
// module resolver via Function so the dynamic import stays a real ESM
// import at runtime instead of being downleveled to require().
const dynamicImport = new Function('p', 'return import(p)') as
  (p: string) => Promise<typeof import('get-windows')>;

let openWindowsCached: typeof import('get-windows').openWindows | null = null;

async function loadOpenWindows() {
  if (openWindowsCached) return openWindowsCached;
  try {
    const lib = await dynamicImport('get-windows');
    openWindowsCached = lib.openWindows;
    return openWindowsCached;
  } catch (err) {
    console.warn('[nom][windows] get-windows unavailable:', (err as Error).message);
    return null;
  }
}

/** Apps we never want the pet to perch on (system chrome, menu HUDs, etc). */
const OWNER_BLACKLIST = new Set<string>([
  'nom',
  'Dock',
  'Window Server',
  'SystemUIServer',
  'ControlCenter',
  'Spotlight',
  'NotificationCenter',
  'WindowManager',
  'TextInputMenuAgent',
  'loginwindow',
]);

const MIN_WIN_DIM = 200; // ignore tiny widgets — too small a perch

export async function listVisibleWindows(): Promise<VisibleWindow[]> {
  const openWindows = await loadOpenWindows();
  if (!openWindows) return [];
  try {
    const raw = await openWindows({
      // We only need bounds — not titles or URLs. Skipping these flags
      // avoids the macOS Screen Recording / Accessibility permission
      // prompts that otherwise pop up the first time we call.
      accessibilityPermission: false,
      screenRecordingPermission: false,
    });
    return raw
      .filter((w) => !OWNER_BLACKLIST.has(w.owner.name))
      .filter((w) => w.bounds.width >= MIN_WIN_DIM && w.bounds.height >= MIN_WIN_DIM)
      .map((w) => ({
        owner: w.owner.name,
        x: w.bounds.x,
        y: w.bounds.y,
        w: w.bounds.width,
        h: w.bounds.height,
      }));
  } catch (err) {
    console.warn('[nom][windows] openWindows failed:', (err as Error).message);
    return [];
  }
}
