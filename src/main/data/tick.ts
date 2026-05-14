import { EventEmitter } from 'node:events';
import type { Mood } from '../../shared/types';
import { Store, todayKey } from './store';
import {
  appendNote,
  incrementBubbleCount,
  readAbsence,
  readMood,
  readTodayBubbleCount,
  touchAbsence,
  writeLastTick,
  writeMood,
} from './pet-mind';
import { maybeDrift } from './mood';
import { gatherObservations } from './observation';
import { decideAutonomousAction } from './llm';
import type { Decision, DecisionContext } from './autonomy-prompt';

/**
 * The pet's autonomous heartbeat. Phase 1 wired the scaffolding (pet-
 * mind / mood drift / observations). Phase 2 adds the LLM decision
 * step: each tick we ask the language model "given who you are and
 * what just happened, should you do anything?" and either stay silent,
 * speak a bubble, write a private note, or shift mood.
 *
 * The engine emits two kinds of events the main process subscribes to:
 *   - 'bubble' { text, mood, kind, durationMs }   — show in renderer
 *   - 'decision' { action, reason }                — for the Phase-3
 *                                                    transparency widget
 *
 * Long-absence return reactions go through onActivity (not the tick)
 * so they fire immediately when the user shows back up after being
 * gone — no waiting for the next 30-min tick.
 */

export interface BubbleEvent {
  text: string;
  mood: Mood;
  /** What triggered this bubble. Renderer doesn't differentiate yet but
   * the field is useful for analytics + Phase-3 styling decisions. */
  kind: 'autonomous' | 'return' | 'question';
  durationMs: number;
}

export interface DecisionEvent {
  action: Decision['action'];
  reason: string;
}

export interface TickEngineEvents {
  bubble: (event: BubbleEvent) => void;
  decision: (event: DecisionEvent) => void;
}

export declare interface TickEngine {
  on<K extends keyof TickEngineEvents>(event: K, listener: TickEngineEvents[K]): this;
  emit<K extends keyof TickEngineEvents>(event: K, ...args: Parameters<TickEngineEvents[K]>): boolean;
}

const FIRST_TICK_DELAY_MS = 60_000;   // 60 s after start, so launches don't slam

// Long-absence threshold: under 4 h is "normal break"; longer than this
// triggers the homecoming reaction.
const RETURN_REACTION_THRESHOLD_HOURS = 4;

// Bubble dwell time (how long a Phase-2 autonomy bubble stays on screen).
// A touch longer than user-clicked dialogues since these are surprise
// pop-ups the user wasn't already looking at.
const BUBBLE_DURATION_MS = 5500;

export class TickEngine extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private store: Store) {
    super();
  }

  start(): void {
    const settings = this.store.getSettings().autonomy;
    if (!settings.enabled) return;
    if (this.running) return;
    this.running = true;

    const intervalMs = Math.max(1, settings.tickIntervalMin) * 60 * 1000;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.tick('first-tick');
      this.timer = setInterval(() => void this.tick('interval'), intervalMs);
    }, FIRST_TICK_DELAY_MS);
    console.log(`[nom][tick] started — interval ${settings.tickIntervalMin} min`);
  }

  stop(): void {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer)      { clearInterval(this.timer); this.timer = null; }
    this.running = false;
  }

  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * Called by main on every token event. Updates the absence record so
   * the next tick can reason about idle time, AND — Phase 2 — fires the
   * "homecoming" bubble when the user returns after a long gap. The
   * homecoming path uses the regular LLM dialogue model (NOT the
   * decision JSON path) because the action is decided here in code; we
   * only need the language model to produce the line.
   */
  async onActivity(now: number): Promise<void> {
    const { gapHours } = await touchAbsence(now);
    if (gapHours < 1) return; // typical mid-session, no reaction

    const mood = await readMood();
    // Always log the return into pet-mind so future ticks can cite it.
    if (gapHours >= 4) {
      await appendNote({
        ts: new Date(now).toISOString(),
        mood: mood.current,
        kind: 'observation',
        text: `主人回来了，离开了 ${gapHours.toFixed(1)} 小时${gapHours >= 24 ? '，这次有点久' : ''}。`,
      });
    }

    // Don't emit a homecoming bubble unless autonomy is on AND we
    // have an LLM configured AND we still have today's bubble quota.
    const settings = this.store.getSettings();
    if (!settings.autonomy.enabled) return;
    if (!settings.llm?.enabled) return;
    if (gapHours < RETURN_REACTION_THRESHOLD_HOURS) return;

    const { count } = await readTodayBubbleCount();
    if (count >= settings.autonomy.maxBubblesPerDay) return;

    // We piggy-back on the decision LLM so the line is in-persona,
    // mood-tinted, and produced through the same JSON path we already
    // know works. The observations list is hand-built around "the user
    // just returned" so the model has something concrete to react to.
    const ctx: DecisionContext = await this.buildDecisionContext({
      forcedSpeak: `主人刚刚回来，离开了 ${gapHours.toFixed(1)} 小时。这是一个"回家"瞬间，主人很期待你的反应。`,
      hour: new Date(now).getHours(),
      hoursSinceLastActive: gapHours,
    });
    // The decision LLM is biased toward silent, but for a return we
    // *want* speech — so we use generateLine instead, with a "wake"
    // trigger and the gap baked into the user prompt. The same mood
    // tint is applied via composeSystemPrompt.
    const { generateLine } = await import('./llm');
    const line = await generateLine(
      settings.llm,
      {
        trigger: 'wake',
        hour: ctx.hour,
        petName: settings.petName,
        minutesSinceLastFed: Math.round(gapHours * 60),
      },
      settings.soulKernel,
      mood.current,
    );
    if (!line) return;

    const newCount = await incrementBubbleCount(now);
    console.log(`[nom][tick] return-reaction bubble (${newCount}/${settings.autonomy.maxBubblesPerDay}): ${line}`);
    this.emit('bubble', {
      text: line,
      mood: mood.current,
      kind: 'return',
      durationMs: BUBBLE_DURATION_MS,
    });
  }

  /**
   * One tick. Drift mood, gather observations, optionally call the
   * decision LLM, execute whichever action it picked. Returns silently
   * on any error path — the heartbeat must never crash the main
   * process, even when the LLM endpoint is broken.
   */
  private async tick(reason: string): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.autonomy.enabled) {
      this.stop();
      return;
    }

    const now = Date.now();
    const snap = this.store.snapshot();
    const { gapHours: rawGap } = await touchAbsenceReadOnly(now);
    const idleMinutes = Number.isFinite(rawGap) ? rawGap * 60 : Number.POSITIVE_INFINITY;
    const hoursSinceLastActive = Number.isFinite(rawGap) ? rawGap : 9999;

    // Phase 1 mechanic — mood drift remains rule-based.
    const drifted = await maybeDrift({
      now,
      idleMinutes,
      todayTokens: snap.today,
    });

    const observations = await gatherObservations(this.store);

    // Without LLM we degrade to Phase-1 behaviour: just record an
    // observation note and exit silently.
    if (!settings.llm?.enabled) {
      await this.recordObservationNote(observations, drifted?.current);
      await writeLastTick({
        at: new Date(now).toISOString(),
        decision: drifted ? 'mood_shift' : (observations[0] ? 'observation' : 'silent'),
      });
      console.log(`[nom][tick] ${reason} · llm off · obs=${observations[0]?.kind ?? 'none'}`);
      return;
    }

    // Hard rate limit before we even call the LLM.
    const { count: todayBubbleCount, lastAt } = await readTodayBubbleCount();
    const hoursSinceLastSpoke = lastAt
      ? (now - Date.parse(lastAt)) / 3_600_000
      : null;

    const decisionCtx: DecisionContext = await this.buildDecisionContext({
      hour: new Date(now).getHours(),
      hoursSinceLastActive,
      hoursSinceLastSpoke,
      todayBubbleCount,
      // If quota is gone, force the decision toward silent by saying so
      // explicitly in the prompt. Even if the model still tries to
      // speak, we'll filter it out below.
      observationsOverride: observations,
    });

    const decision = await decideAutonomousAction(settings.llm, decisionCtx);
    await this.executeDecision({
      decision,
      now,
      drifted,
      observations,
      todayBubbleCount,
      maxBubbles: settings.autonomy.maxBubblesPerDay,
    });
    console.log(
      `[nom][tick] ${reason} · mood=${drifted?.current ?? 'unchanged'}` +
      ` · decision=${decision?.action ?? 'parse-fail'}` +
      ` · today=${snap.today}` +
      ` · day=${todayKey()}`
    );
  }

  // ── Phase 2 helpers ───────────────────────────────────────────────

  private async buildDecisionContext(extra: {
    hour: number;
    hoursSinceLastActive: number;
    hoursSinceLastSpoke?: number | null;
    todayBubbleCount?: number;
    forcedSpeak?: string;
    observationsOverride?: Awaited<ReturnType<typeof gatherObservations>>;
  }): Promise<DecisionContext> {
    const settings = this.store.getSettings();
    const mood = await readMood();
    const [observations, recentNotes] = await Promise.all([
      extra.observationsOverride
        ? Promise.resolve(extra.observationsOverride)
        : gatherObservations(this.store),
      (await import('./pet-mind')).readRecentNotes(5),
    ]);
    const bubble = extra.todayBubbleCount != null
      ? { count: extra.todayBubbleCount, lastAt: null }
      : await readTodayBubbleCount();
    const hoursSinceLastSpoke = extra.hoursSinceLastSpoke
      ?? (bubble.lastAt
        ? (Date.now() - Date.parse(bubble.lastAt)) / 3_600_000
        : null);
    const obsForCtx = extra.forcedSpeak
      ? [{ kind: 'idle-gap' as const, significance: 1, data: extra.forcedSpeak }, ...observations]
      : observations;
    return {
      petName: settings.petName,
      soulKernel: settings.soulKernel,
      mood: mood.current,
      recentNotes,
      observations: obsForCtx,
      todayBubbleCount: bubble.count,
      maxBubblesPerDay: settings.autonomy.maxBubblesPerDay,
      hoursSinceLastSpoke,
      hoursSinceLastActive: extra.hoursSinceLastActive,
      hour: extra.hour,
    };
  }

  private async executeDecision(args: {
    decision: Decision | null;
    now: number;
    drifted: { current: Mood } | null;
    observations: Awaited<ReturnType<typeof gatherObservations>>;
    todayBubbleCount: number;
    maxBubbles: number;
  }): Promise<void> {
    const { decision, now, drifted, observations, todayBubbleCount, maxBubbles } = args;
    const baseMood = (drifted?.current ?? (await readMood()).current) as Mood;
    const tsIso = new Date(now).toISOString();

    // Null = LLM failed / parse failed / silent. Fall through to the
    // Phase-1 observation note so the tick still leaves a trace.
    if (!decision || decision.action === 'silent') {
      await this.recordObservationNote(observations, baseMood);
      // Always 'silent' here — narrowing's just being shy.
      await writeLastTick({ at: tsIso, decision: 'silent' });
      this.emit('decision', { action: 'silent', reason: decision?.reason ?? 'no-decision' });
      return;
    }

    switch (decision.action) {
      case 'speak':
      case 'ask': {
        if (!decision.content) return;
        if (todayBubbleCount >= maxBubbles) {
          // Quota exceeded — demote to a private note so the work
          // wasn't wasted and the LLM's good observation still lives
          // somewhere.
          await appendNote({ ts: tsIso, mood: baseMood, kind: 'opinion', text: decision.content });
          await writeLastTick({ at: tsIso, decision: 'note' });
          this.emit('decision', { action: 'silent', reason: 'quota-exceeded' });
          return;
        }
        const newCount = await incrementBubbleCount(now);
        await appendNote({ ts: tsIso, mood: baseMood, kind: 'opinion', text: decision.content });
        await writeLastTick({ at: tsIso, decision: decision.action });
        console.log(`[nom][tick] ${decision.action} (${newCount}/${maxBubbles}): ${decision.content}`);
        this.emit('bubble', {
          text: decision.content,
          mood: baseMood,
          kind: decision.action === 'ask' ? 'question' : 'autonomous',
          durationMs: BUBBLE_DURATION_MS,
        });
        this.emit('decision', { action: decision.action, reason: decision.reason ?? '' });
        return;
      }
      case 'write_note': {
        if (!decision.note) return;
        await appendNote({ ts: tsIso, mood: baseMood, kind: 'opinion', text: decision.note });
        await writeLastTick({ at: tsIso, decision: 'note' });
        this.emit('decision', { action: 'write_note', reason: decision.reason ?? '' });
        return;
      }
      case 'shift_mood': {
        if (!decision.newMood || decision.newMood === baseMood) return;
        const updated = {
          current: decision.newMood,
          shiftedAt: tsIso,
          reason: decision.reason ?? 'LLM-decided shift',
          recent: (await readMood()).recent.concat({
            from: baseMood,
            to: decision.newMood,
            at: tsIso,
            reason: decision.reason ?? 'LLM-decided shift',
          }).slice(-20),
        };
        await writeMood(updated);
        await writeLastTick({ at: tsIso, decision: 'mood_shift' });
        this.emit('decision', { action: 'shift_mood', reason: decision.reason ?? '' });
        return;
      }
    }
  }

  /** Phase-1 fallback: write a single observation note, no LLM. */
  private async recordObservationNote(
    observations: Awaited<ReturnType<typeof gatherObservations>>,
    moodOverride?: Mood,
  ): Promise<void> {
    if (observations.length === 0) return;
    const top = observations[0]!;
    const mood = moodOverride ?? (await readMood()).current;
    await appendNote({
      ts: new Date().toISOString(),
      mood,
      kind: 'observation',
      text: top.data,
    });
  }
}

/**
 * Internal helper: same as touchAbsence but doesn't write back — used
 * inside the tick to peek at the current gap without bumping the
 * lastActiveAt stamp (only onActivity should bump it, since "the tick
 * happened" doesn't count as the user showing up).
 */
async function touchAbsenceReadOnly(now: number): Promise<{ gapHours: number }> {
  const abs = await readAbsence();
  if (!abs.lastActiveAt) return { gapHours: Infinity };
  const gapHours = (now - Date.parse(abs.lastActiveAt)) / 3_600_000;
  return { gapHours: Number.isFinite(gapHours) && gapHours >= 0 ? gapHours : 0 };
}
