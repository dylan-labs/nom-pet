import React, { useEffect, useState } from 'react';
import type { NomApi } from '../../preload';
import type { WeeklyCardPayload, WeeklyCardStyle } from '../../shared/types';
import { GameBoyCard } from './GameBoyCard';
import { TerminalCard } from './TerminalCard';

declare global {
  interface Window {
    nom: NomApi;
  }
}

function readStyleFromQuery(): WeeklyCardStyle {
  const params = new URLSearchParams(window.location.search);
  const s = params.get('style');
  return s === 'terminal' ? 'terminal' : 'gameboy';
}

export function CardApp(): React.JSX.Element | null {
  const [payload, setPayload] = useState<WeeklyCardPayload | null>(null);
  const styleHint = readStyleFromQuery();

  useEffect(() => {
    window.nom.getCardPayload().then((p) => setPayload(p)).catch(() => setPayload(null));
  }, []);

  useEffect(() => {
    if (!payload) return;
    // Two rAF nests ensure the browser has actually committed the painted
    // frame before we tell main to capturePage — otherwise we sometimes
    // grab a half-styled first paint.
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        window.nom.cardReady();
      });
      return () => cancelAnimationFrame(id2);
    });
    return () => cancelAnimationFrame(id1);
  }, [payload]);

  if (!payload) return null;
  const style = payload.style ?? styleHint;
  if (style === 'terminal') return <TerminalCard report={payload.report} />;
  return <GameBoyCard report={payload.report} />;
}
