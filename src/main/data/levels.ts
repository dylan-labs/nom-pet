/**
 * Token-eaten level system. PUBG-style tier (大段位) + sub-level (子级 III/II/I).
 *
 * Rationale (设计依据):
 *  - Most users (50M tokens/day "casual") plateau in 学徒 — that's where the
 *    bell curve lives.
 *  - Heavy users (500M tokens/day) reach 行家 in months, 大师 in years.
 *  - 宗师 / 传说 / 战神 are mythical — flex-only, no one realistically reaches.
 *
 * Table indexed by sequential `index` so we can detect "level went up by N
 * sub-levels" or "tier jumped" in level-up animations.
 */

export interface LevelInfo {
  index: number;           // 0..LEVELS.length-1
  tier: string;            // 新手 / 学徒 / 行家 / 大师 / 宗师 / 传说 / 战神
  subLevel: string | null; // III / II / I, or null for single-step tiers
  badge: string;           // pre-formatted display text
  threshold: number;       // cumulative tokens to reach this level
  nextThreshold: number | null;
  progress: number;        // 0..1 toward next sub-level (0 if at top)
  isTierStart: boolean;    // first sub-level of its tier — used for tier-jump animation
}

interface LevelEntry {
  tier: string;
  sub: string | null;
  threshold: number;
}

const LEVELS: LevelEntry[] = [
  { tier: '新手', sub: 'III', threshold: 0 },
  { tier: '新手', sub: 'II',  threshold: 50_000_000 },
  { tier: '新手', sub: 'I',   threshold: 500_000_000 },
  { tier: '学徒', sub: 'III', threshold: 5_000_000_000 },
  { tier: '学徒', sub: 'II',  threshold: 20_000_000_000 },
  { tier: '学徒', sub: 'I',   threshold: 50_000_000_000 },
  { tier: '行家', sub: 'III', threshold: 150_000_000_000 },
  { tier: '行家', sub: 'II',  threshold: 500_000_000_000 },
  { tier: '行家', sub: 'I',   threshold: 1_500_000_000_000 },
  { tier: '大师', sub: 'III', threshold: 5_000_000_000_000 },
  { tier: '大师', sub: 'II',  threshold: 15_000_000_000_000 },
  { tier: '大师', sub: 'I',   threshold: 50_000_000_000_000 },
  { tier: '宗师', sub: 'III', threshold: 150_000_000_000_000 },
  { tier: '宗师', sub: 'II',  threshold: 500_000_000_000_000 },
  { tier: '宗师', sub: 'I',   threshold: 1_500_000_000_000_000 },
  { tier: '传说', sub: null,  threshold: 5_000_000_000_000_000 },
  { tier: '战神', sub: null,  threshold: 50_000_000_000_000_000 },
];

/** Badge text ("行家 III" / "战神") for the level at the given index, or null past the table. */
export function levelBadgeAt(index: number): string | null {
  const e = LEVELS[index];
  if (!e) return null;
  return e.sub ? `${e.tier} ${e.sub}` : e.tier;
}

export function computeLevel(cumulative: number): LevelInfo {
  let idx = 0;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (cumulative >= LEVELS[i]!.threshold) { idx = i; break; }
  }
  const cur = LEVELS[idx]!;
  const next = LEVELS[idx + 1] ?? null;
  const span = next ? next.threshold - cur.threshold : 0;
  const progress = next && span > 0
    ? Math.min(1, Math.max(0, (cumulative - cur.threshold) / span))
    : 0;
  const prevTier = idx > 0 ? LEVELS[idx - 1]!.tier : null;
  return {
    index: idx,
    tier: cur.tier,
    subLevel: cur.sub,
    badge: cur.sub ? `${cur.tier} ${cur.sub}` : cur.tier,
    threshold: cur.threshold,
    nextThreshold: next?.threshold ?? null,
    progress,
    isTierStart: prevTier !== cur.tier,
  };
}
