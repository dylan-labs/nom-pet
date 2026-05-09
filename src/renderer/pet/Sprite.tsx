import React, { useEffect, useState, useRef } from 'react';
import bundledConfigJson from '@assets/pets/default/pet.json';
import bundledSpritesheetUrl from '@assets/pets/default/spritesheet.png';
import type { PetConfig } from '../../shared/types';

export type PetState = 'idle' | 'eating' | 'sleeping' | 'talking' | 'dragging' | 'walking';

interface ActivePet {
  config: PetConfig;
  spritesheetUrl: string;
}

const BUNDLED: ActivePet = {
  config: bundledConfigJson as PetConfig,
  spritesheetUrl: bundledSpritesheetUrl,
};

interface SpriteProps {
  state: PetState;
  facing?: 'left' | 'right';
}

export function Sprite({ state, facing = 'right' }: SpriteProps) {
  const [active, setActive] = useState<ActivePet>(BUNDLED);

  // Try to load a user-installed pet (active slug from settings).
  // Fall back to bundled if none. Re-fetch on right-click pet switch.
  useEffect(() => {
    function reload() {
      void window.nom.getUserPet().then((userPet) => {
        setActive(userPet
          ? { config: userPet.config, spritesheetUrl: userPet.spritesheetDataUrl }
          : BUNDLED);
      }).catch(() => {/* keep current */});
    }
    reload();
    return window.nom.onPetChanged(reload);
  }, []);

  const config = active.config;
  const stateConfig = config.states[state] ?? config.states.idle!;
  const frames = stateConfig.frames;
  const fps = Math.max(0.1, stateConfig.fps);
  const displayScale = config.displayScale ?? 2;

  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);

  useEffect(() => {
    setTick(0);
    tickRef.current = 0;
    if (frames.length <= 1) return;
    const intervalMs = 1000 / fps;
    const id = setInterval(() => {
      tickRef.current += 1;
      setTick(tickRef.current);
    }, intervalMs);
    return () => clearInterval(id);
  }, [state, frames.length, fps, active]);

  const frameNumber = frames[tick % frames.length]!;
  const cols = config.frame.cols;
  const col = frameNumber % cols;
  const row = Math.floor(frameNumber / cols);

  // Render at the *displayed* size so the layout box matches the visible
  // pixels. This keeps the .pet hit area tight to the sprite — no more
  // grab-cursor showing across the empty corners of the 200×200 window.
  const renderedW = config.frame.width * displayScale;
  const renderedH = config.frame.height * displayScale;
  const sheetW = cols * renderedW;
  const x = -col * renderedW;
  const y = -row * renderedH;

  // Pixelated rendering only makes sense when scaling small pixel art UP.
  // For high-res sprites being scaled DOWN, smooth rendering looks better.
  const imageRendering = displayScale > 1 ? 'pixelated' : 'auto';

  return (
    <div
      className="sprite"
      style={{
        width: renderedW,
        height: renderedH,
        backgroundImage: `url(${active.spritesheetUrl})`,
        backgroundPosition: `${x}px ${y}px`,
        backgroundSize: `${sheetW}px auto`,
        backgroundRepeat: 'no-repeat',
        imageRendering,
        transform: `scaleX(${facing === 'left' ? -1 : 1})`,
      }}
    />
  );
}
