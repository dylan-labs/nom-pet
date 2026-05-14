import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PetConfig, LoadedPet, InstalledPetInfo } from '../../shared/types';

/**
 * Where to look for user-installed pets, in priority order:
 *   1. ~/.codex/pets/   ← PetDex CLI installs here (`npx petdex install <slug>`)
 *   2. ~/.nom/pets/     ← manually-dropped packs
 *
 * If `NOM_PET=<slug>` env var is set, only that slug is loaded (from whichever
 * directory has it). Otherwise the first valid pet found is used.
 */
const SEARCH_DIRS = [
  path.join(os.homedir(), '.codex', 'pets'),
  path.join(os.homedir(), '.nom', 'pets'),
];

/**
 * PetDex sprite convention (decoded from MIT-licensed crafter-station/petdex):
 *   192 × 208 px frames, laid out 8 cols × 9 rows in a 1536 × 1872 sheet.
 *   Row 0: idle (6f), Row 1: running-right (8f), Row 2: running-left (8f),
 *   Row 3: waving (4f), Row 4: jumping (5f), Row 5: failed (8f),
 *   Row 6: waiting (6f), Row 7: running-generic (6f), Row 8: review (6f).
 *   Mapped to nom's 6 states. Directional states (walking/dragging) read
 *   row 1 by default and row 2 when facing left — per the maintainer,
 *   downstream apps should pull the correct row, not CSS-flip.
 */
const PETDEX_COLS = 8;

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

function isPetDexFormat(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'spritesheetPath' in raw &&
    !('frame' in raw)
  );
}

function petdexToNative(raw: any): PetConfig {
  const runRight = range(1 * PETDEX_COLS, 8);
  const runLeft = range(2 * PETDEX_COLS, 8);
  return {
    id: raw.id ?? 'user',
    name: raw.displayName ?? raw.id ?? 'Pet',
    description: raw.description,
    spritesheet: raw.spritesheetPath ?? 'spritesheet.webp',
    frame: { width: 192, height: 208, cols: PETDEX_COLS },
    displayScale: 0.4,
    states: {
      idle:     { frames: range(0 * PETDEX_COLS, 6), fps: 5.5 },
      walking:  { frames: runRight, framesLeft: runLeft, fps: 7 },
      dragging: { frames: runRight, framesLeft: runLeft, fps: 12 },
      talking:  { frames: range(3 * PETDEX_COLS, 4), fps: 5.7 },
      eating:   { frames: range(4 * PETDEX_COLS, 5), fps: 6.0 },
      sleeping: { frames: range(6 * PETDEX_COLS, 6), fps: 4.0 },
    },
  };
}

function mimeFor(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

async function tryLoadDir(dir: string, slug: string): Promise<LoadedPet | null> {
  try {
    const configText = await fs.readFile(path.join(dir, 'pet.json'), 'utf8');
    const raw = JSON.parse(configText);
    const config: PetConfig = isPetDexFormat(raw) ? petdexToNative(raw) : (raw as PetConfig);
    const spritePath = path.join(dir, config.spritesheet);
    const buf = await fs.readFile(spritePath);
    const dataUrl = `data:${mimeFor(config.spritesheet)};base64,${buf.toString('base64')}`;
    return { slug, config, spritesheetDataUrl: dataUrl };
  } catch {
    return null;
  }
}

/**
 * Scan the user's local pet directories (PetDex's ~/.codex/pets/ and
 * ~/.nom/pets/) and return the requested pack — picked by, in priority order:
 *   1. `desiredSlug` arg (settings.activePetSlug from the user's chosen skin)
 *   2. NOM_PET env var
 *   3. first valid pet found
 * Returns null if nothing found — the renderer then falls back to bundled.
 */
export async function loadUserPet(desiredSlug?: string | null): Promise<LoadedPet | null> {
  const requested = desiredSlug?.trim() || process.env['NOM_PET']?.trim() || null;

  for (const root of SEARCH_DIRS) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (requested && entry.name !== requested) continue;
      const dir = path.join(root, entry.name);
      const pet = await tryLoadDir(dir, entry.name);
      if (pet) {
        console.log(`[nom] loaded pet "${entry.name}" from ${root}`);
        return pet;
      }
    }
  }

  if (requested) {
    console.log(`[nom] requested pet "${requested}" not found in ~/.codex/pets/ or ~/.nom/pets/`);
  }
  return null;
}

/**
 * List every installed pet across both search dirs. Dedupes by slug — first
 * dir wins (same priority as loadUserPet). Used to populate the right-click
 * "选择宠物" submenu.
 */
export async function listInstalledPets(): Promise<InstalledPetInfo[]> {
  const out = new Map<string, InstalledPetInfo>();
  for (const root of SEARCH_DIRS) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (out.has(entry.name)) continue;
      try {
        const text = await fs.readFile(path.join(root, entry.name, 'pet.json'), 'utf8');
        const raw = JSON.parse(text);
        const displayName = raw.displayName ?? raw.name ?? raw.id ?? entry.name;
        out.set(entry.name, { slug: entry.name, displayName });
      } catch {
        // not a valid pet pack; skip
      }
    }
  }
  return Array.from(out.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}
