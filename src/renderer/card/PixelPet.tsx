import React from 'react';

interface Props {
  size: number;
  bodyColor: string;
  eyeColor: string;
  cheekColor: string;
  background?: string;
}

/**
 * 16×16 pixel mascot face — hand-tuned so the same mascot reads in both the
 * Game Boy yellow-green and the terminal green palette. Each row is 16
 * characters: 'X' = body, 'o' = eye, 'p' = cheek, 'm' = mouth, '.' = empty.
 */
const SPRITE = [
  '................',
  '....XXXXXXXX....',
  '...XXXXXXXXXX...',
  '..XXXXXXXXXXXX..',
  '.XXXXXXXXXXXXXX.',
  '.XXXooXXXXooXXX.',
  '.XXXooXXXXooXXX.',
  '.XXXXXXXXXXXXXX.',
  '.XXXXXXmmXXXXXX.',
  '.XXppXXmmXXppXX.',
  '.XXppXXXXXXppXX.',
  '.XXXXXXXXXXXXXX.',
  '..XXXXXXXXXXXX..',
  '...XXXXXXXXXX...',
  '....XXXXXXXX....',
  '................',
] as const;

export function PixelPet({ size, bodyColor, eyeColor, cheekColor, background }: Props): React.JSX.Element {
  const pixel = size / 16;
  const rects: React.JSX.Element[] = [];
  for (let y = 0; y < 16; y++) {
    const row = SPRITE[y]!;
    for (let x = 0; x < 16; x++) {
      const ch = row[x];
      let fill: string | null = null;
      if (ch === 'X') fill = bodyColor;
      else if (ch === 'o') fill = eyeColor;
      else if (ch === 'p') fill = cheekColor;
      else if (ch === 'm') fill = eyeColor;
      if (fill) {
        rects.push(<rect key={`${x}-${y}`} x={x * pixel} y={y * pixel} width={pixel} height={pixel} fill={fill} />);
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" style={{ display: 'block' }}>
      {background ? <rect x={0} y={0} width={size} height={size} fill={background} /> : null}
      {rects}
    </svg>
  );
}
