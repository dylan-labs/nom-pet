import type { Mood, MoodState } from '../../shared/types';
import { readMood, writeMood } from './pet-mind';

/**
 * Deterministic mood drift. Phase 1 implements pure rule-based shifts —
 * no LLM involvement — so the pet has a believable inner rhythm even
 * before the decision LLM is wired up in Phase 2. The big design choices:
 *
 *   - Stickiness ≥ 60%. Most ticks leave mood alone. A mood that
 *     thrashes between vivacious and withdrawn every half hour reads
 *     as broken, not alive.
 *   - 4-hour cooldown. Even if conditions favour a shift, we don't
 *     move mood twice in the same evening — gives each mood time to
 *     show through dialogue.
 *   - Time of day + idle gap + today-token-volume are the three input
 *     signals. Each is a small probability nudge, not a hard rule.
 *
 * Returns the new MoodState when a drift happened, or null when the
 * mood stayed put. Caller persists the result.
 */

export interface MoodDriftContext {
  now: number;
  /** Minutes since the user last fed the pet (any source). Infinity → never fed. */
  idleMinutes: number;
  /** Today's total token intake — sets fatigue-style cues for the pet. */
  todayTokens: number;
}

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const BASE_DRIFT_PROBABILITY = 0.35;    // probability of *any* drift attempt (before bias)

// Hand-tuned target weights for each mood given the current context.
// Higher number = more likely to be the next mood. The current mood
// gets a 1.7x stickiness multiplier so it's the most likely outcome
// unless context strongly disagrees.
function weights(ctx: MoodDriftContext, current: Mood): Record<Mood, number> {
  const hour = new Date(ctx.now).getHours();
  const isLateNight = hour < 6 || hour >= 23;
  const isMorning = hour >= 6 && hour < 11;
  const isAfternoon = hour >= 13 && hour < 17;
  const isEvening = hour >= 17 && hour < 22;

  const idleH = ctx.idleMinutes / 60;
  const veryIdle = idleH >= 3;
  const fairlyIdle = idleH >= 1 && idleH < 3;

  const tokensHigh = ctx.todayTokens > 5_000_000;       // heavy day
  const tokensLow = ctx.todayTokens < 100_000;          // basically nothing

  // Default base weights — each mood starts somewhere reasonable.
  const w: Record<Mood, number> = {
    vivacious: 1.0,
    normal:    2.5,    // normal is the gravitational center
    pensive:   1.0,
    cranky:    0.7,
    withdrawn: 0.5,
  };

  // Time-of-day biases.
  if (isMorning)   { w.vivacious *= 1.6; w.withdrawn *= 0.5; }
  if (isAfternoon) { w.normal *= 1.2; }
  if (isEvening)   { w.pensive *= 1.4; }
  if (isLateNight) { w.pensive *= 1.6; w.withdrawn *= 1.4; w.vivacious *= 0.3; }

  // Idle biases.
  if (veryIdle)    { w.withdrawn *= 1.8; w.cranky *= 1.4; w.vivacious *= 0.4; }
  else if (fairlyIdle) { w.pensive *= 1.3; }
  else             { w.vivacious *= 1.2; }

  // Token-volume biases.
  if (tokensHigh)  { w.pensive *= 1.3; w.cranky *= 1.2; } // overstuffed → contemplative / grumpy
  if (tokensLow)   { w.cranky *= 1.3;  w.withdrawn *= 1.2; } // starved → grumpy / lonely

  // Stickiness — the current mood gets a strong multiplier so it's
  // usually the winner unless context really disagrees.
  w[current] *= 1.7;

  return w;
}

function pickWeighted(w: Record<Mood, number>): Mood {
  const total = Object.values(w).reduce((s, n) => s + n, 0);
  let r = Math.random() * total;
  for (const m of Object.keys(w) as Mood[]) {
    r -= w[m];
    if (r <= 0) return m;
  }
  return 'normal'; // theoretically unreachable
}

/**
 * Human-readable cause of the drift. Surfaced in the transparency widget
 * so users can see why their pet went moody — same information drove
 * the weights above.
 */
function driftReason(ctx: MoodDriftContext, to: Mood): string {
  const hour = new Date(ctx.now).getHours();
  const idleH = ctx.idleMinutes / 60;
  if (idleH >= 6) return `主人 ${idleH.toFixed(1)} 小时没出现`;
  if (hour < 6) return `凌晨 ${hour} 点了`;
  if (hour >= 23) return `深夜了`;
  if (hour >= 6 && hour < 11 && to === 'vivacious') return '早上的精神头';
  if (ctx.todayTokens > 5_000_000 && to === 'pensive') return '主人今天吃太多 token，胀';
  if (ctx.todayTokens < 100_000 && (to === 'cranky' || to === 'withdrawn')) return '今天主人几乎没喂我';
  return '说不上来，就是变了';
}

/**
 * Probabilistically drift the mood per tick. Cooldown enforces ≥ 4h
 * between drifts; base probability gates whether we even attempt a
 * weighted draw; if mood does change, we persist + return the new state.
 */
export async function maybeDrift(ctx: MoodDriftContext): Promise<MoodState | null> {
  const cur = await readMood();
  const sinceShift = ctx.now - Date.parse(cur.shiftedAt);
  if (sinceShift < COOLDOWN_MS) return null;

  if (Math.random() > BASE_DRIFT_PROBABILITY) return null;

  const w = weights(ctx, cur.current);
  const next = pickWeighted(w);
  if (next === cur.current) return null;

  const reason = driftReason(ctx, next);
  const updated: MoodState = {
    current: next,
    shiftedAt: new Date(ctx.now).toISOString(),
    reason,
    recent: [
      ...cur.recent.slice(-19),
      { from: cur.current, to: next, at: new Date(ctx.now).toISOString(), reason },
    ],
  };
  await writeMood(updated);
  return updated;
}

/**
 * Human-friendly adjective for each mood — flows into the LLM system
 * prompt so the language model can colour its output without us having
 * to enumerate every nuance.
 */
export function moodAdjective(m: Mood): string {
  switch (m) {
    case 'vivacious': return '今天精神特别足，话比平时多一点';
    case 'normal':    return '心情如常';
    case 'pensive':   return '今天偏内省，话稠而少';
    case 'cranky':    return '今天比平时刻薄 30%，看什么都不顺眼';
    case 'withdrawn': return '今天极度简短，只想缩在角落';
  }
}
