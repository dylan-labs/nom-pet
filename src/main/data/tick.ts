import { EventEmitter } from 'node:events';
import type { Mood } from '../../shared/types';
import { Store, todayKey } from './store';
import {
  appendNote,
  incrementBubbleCount,
  localIsoString,
  readAbsence,
  readMood,
  readTodayBubbleCount,
  touchAbsence,
  writeLastTick,
  writeMood,
} from './pet-mind';
import { maybeDrift } from './mood';
import { gatherSituation } from './situation';
import { decideAutonomousAction, generateLine } from './llm';
import type { Decision } from './autonomy-prompt';

/**
 * The pet's autonomous heartbeat. Asks the LLM each tick whether it
 * should speak / write a note / shift mood — and otherwise stays silent.
 * The model gets a raw situational snapshot (numbers + qualitative
 * buckets + recent self-notes + activity timeline) and decides for
 * itself what's noteworthy. No rule-based "observation" pre-curation.
 *
 * Emits two kinds of events:
 *   - 'bubble'   — pet decided to speak; renderer shows the bubble
 *   - 'decision' — for the Phase-3 transparency widget
 *
 * Long-absence return reactions go through `onActivity` (not the tick)
 * so they fire immediately on user return instead of waiting up to
 * 30 min for the next scheduled tick.
 */

export interface BubbleEvent {
  text: string;
  mood: Mood;
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

const FIRST_TICK_DELAY_MS = 60_000;            // 60 s after start; let launch noise settle
const RETURN_REACTION_THRESHOLD_HOURS = 4;     // gap before homecoming reaction fires
const BUBBLE_DURATION_MS = 5500;               // autonomy bubbles linger a touch longer than user-clicked

export class TickEngine extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * In-flight onActivity promise — used as a mutex so a burst of token
   * events (multiple JSONL appends within the same second) doesn't
   * fire the "homecoming" path multiple times against the same stale
   * absences.json read.
   */
  private activityChain: Promise<void> = Promise.resolve();

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

  // ── onActivity (token event hook) ───────────────────────────────────

  /**
   * Called on every token event. Updates the absence record and — if
   * the user has been away long enough — fires a homecoming bubble
   * via the dialogue LLM (NOT the decision LLM; the action is decided
   * here in code). Serialised via activityChain so bursty events don't
   * race on absences.json.
   */
  async onActivity(now: number): Promise<void> {
    const prev = this.activityChain;
    let done!: () => void;
    this.activityChain = new Promise<void>((res) => { done = res; });
    try {
      await prev;
      await this.runActivityInner(now);
    } finally {
      done();
    }
  }

  private async runActivityInner(now: number): Promise<void> {
    const { gapHours } = await touchAbsence(now);
    if (gapHours < 1) return; // typical mid-session

    const mood = await readMood();
    if (gapHours >= 4) {
      // Log the return as a fact, separate from any speaking decision.
      // This goes in regardless of LLM / autonomy state so the absence
      // history is always accurate.
      await appendNote({
        ts: localIsoString(now),
        mood: mood.current,
        kind: 'observation',
        text: `主人回来了，离开了 ${gapHours.toFixed(1)} 小时${gapHours >= 24 ? '，这次有点久' : ''}。`,
      });
    }

    const settings = this.store.getSettings();
    if (!settings.autonomy.enabled) return;
    if (!settings.llm?.enabled) return;
    if (gapHours < RETURN_REACTION_THRESHOLD_HOURS) return;

    const { count } = await readTodayBubbleCount();
    if (count >= settings.autonomy.maxBubblesPerDay) return;

    const line = await generateLine(
      settings.llm,
      {
        trigger: 'wake',
        hour: new Date(now).getHours(),
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

  // ── tick (scheduled heartbeat) ──────────────────────────────────────

  /**
   * One tick. Drift mood (deterministic), gather the raw situation,
   * call the decision LLM, execute whatever it chose. On any failure
   * stay silent — the heartbeat must never crash main.
   *
   * When LLM is off (or autonomy is off), we ONLY drift mood + record
   * lastTick. We DO NOT write any rule-based "observation" note —
   * those notes turned out to be the source of fabricated facts the
   * LLM later cited as truth (see late-night bug, v0.0.25).
   */
  private async tick(reason: string): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.autonomy.enabled) {
      this.stop();
      return;
    }

    const now = Date.now();
    const snap = this.store.snapshot();
    const { gapHours } = await peekAbsenceGap(now);
    const idleMinutes = Number.isFinite(gapHours) ? gapHours * 60 : Number.POSITIVE_INFINITY;

    // Mood drift remains rule-based; this is the pet's "biological"
    // rhythm and the rules are honest about what they're based on.
    const drifted = await maybeDrift({
      now,
      idleMinutes,
      todayTokens: snap.today,
    });

    // No LLM → tick is mood-drift-only. Quiet pet, no notebook pollution.
    if (!settings.llm?.enabled) {
      await writeLastTick({
        at: localIsoString(now),
        decision: drifted ? 'mood_shift' : 'silent',
      });
      console.log(`[nom][tick] ${reason} · llm off · mood=${drifted?.current ?? 'unchanged'}`);
      return;
    }

    const situation = await gatherSituation(this.store);
    // Mood may have just drifted; reflect it in the situation we send.
    if (drifted) situation.mood = drifted.current;

    const decision = await decideAutonomousAction(settings.llm, situation);

    await this.executeDecision({
      decision,
      now,
      moodAfter: situation.mood,
    });
    console.log(
      `[nom][tick] ${reason}` +
      ` · mood=${drifted?.current ?? 'unchanged'}` +
      ` · decision=${decision?.action ?? 'parse-fail'}` +
      ` · today=${snap.today}` +
      ` · day=${todayKey()}`
    );
  }

  // ── Decision execution ─────────────────────────────────────────────

  private async executeDecision(args: {
    decision: Decision | null;
    now: number;
    moodAfter: Mood;
  }): Promise<void> {
    const { decision, now, moodAfter } = args;
    const tsIso = localIsoString(now);

    if (!decision || decision.action === 'silent') {
      await writeLastTick({ at: tsIso, decision: 'silent' });
      this.emit('decision', { action: 'silent', reason: decision?.reason ?? 'no-decision' });
      return;
    }

    switch (decision.action) {
      case 'speak':
      case 'ask': {
        if (!decision.content) return;
        const settings = this.store.getSettings();
        const { count } = await readTodayBubbleCount();
        if (count >= settings.autonomy.maxBubblesPerDay) {
          // Out of speak quota — demote to a private note so the
          // model's good observation isn't wasted.
          await appendNote({ ts: tsIso, mood: moodAfter, kind: 'opinion', text: decision.content });
          await writeLastTick({ at: tsIso, decision: 'note' });
          this.emit('decision', { action: 'silent', reason: 'quota-exceeded' });
          return;
        }
        const newCount = await incrementBubbleCount(now);
        await appendNote({ ts: tsIso, mood: moodAfter, kind: 'opinion', text: decision.content });
        await writeLastTick({ at: tsIso, decision: decision.action });
        console.log(`[nom][tick] ${decision.action} (${newCount}/${settings.autonomy.maxBubblesPerDay}): ${decision.content}`);
        this.emit('bubble', {
          text: decision.content,
          mood: moodAfter,
          kind: decision.action === 'ask' ? 'question' : 'autonomous',
          durationMs: BUBBLE_DURATION_MS,
        });
        this.emit('decision', { action: decision.action, reason: decision.reason ?? '' });
        return;
      }
      case 'write_note': {
        if (!decision.note) return;
        await appendNote({ ts: tsIso, mood: moodAfter, kind: 'opinion', text: decision.note });
        await writeLastTick({ at: tsIso, decision: 'note' });
        this.emit('decision', { action: 'write_note', reason: decision.reason ?? '' });
        return;
      }
      case 'shift_mood': {
        if (!decision.newMood || decision.newMood === moodAfter) return;
        const cur = await readMood();
        const updated = {
          current: decision.newMood,
          shiftedAt: tsIso,
          reason: decision.reason ?? 'LLM-decided shift',
          recent: cur.recent.concat({
            from: moodAfter,
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
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Read-only peek at the absence gap. Used inside the tick so we can
 * reason about idle minutes without bumping lastActiveAt (only real
 * token activity should bump that — the tick is the pet thinking, not
 * the user showing up).
 */
async function peekAbsenceGap(now: number): Promise<{ gapHours: number }> {
  const abs = await readAbsence();
  if (!abs.lastActiveAt) return { gapHours: Infinity };
  const h = (now - Date.parse(abs.lastActiveAt)) / 3_600_000;
  return { gapHours: Number.isFinite(h) && h >= 0 ? h : 0 };
}
