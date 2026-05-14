import { Store, todayKey } from './store';
import { appendNote, readAbsence, readMood, touchAbsence, writeLastTick } from './pet-mind';
import { maybeDrift } from './mood';
import { gatherObservations } from './observation';

/**
 * The pet's autonomous heartbeat. Phase 1 of the spec — no LLM yet,
 * just the deterministic scaffolding: every N minutes we let the mood
 * drift, gather an observation, and append a note to pet-mind so the
 * pet builds up a body of "things it has noticed" across sessions.
 * Phase 2 plugs an LLM decision step in here that turns these notes
 * + mood + observations into actual spoken bubbles.
 *
 * Two entry points from main:
 *   - start() / stop()   : managed by main when settings.autonomy.enabled
 *                          toggles; idempotent.
 *   - onActivity(ts)     : called on every token event so the absence
 *                          tracker stays current and long-gap detection
 *                          works on the user's next visit.
 *
 * The engine is reactive to settings changes via restart() — main is
 * expected to call restart() after persisting new autonomy settings.
 */

const FIRST_TICK_DELAY_MS = 60_000;   // 60 s after start, so launches don't slam

export class TickEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private store: Store) {}

  start(): void {
    const settings = this.store.getSettings().autonomy;
    if (!settings.enabled) return;
    if (this.running) return;
    this.running = true;

    const intervalMs = Math.max(1, settings.tickIntervalMin) * 60 * 1000;
    // Stagger the first tick so the first 60 s of launch stays quiet
    // (greeting bubble, daily report, journal generation, lifetime
    // reconcile — all already happening). After the warm-up, settle
    // into the regular cadence.
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
   * Called by main on every token event from any source. Keeps the
   * absence record fresh so the next tick (and future Phase-2 return
   * reactions) can reason about how long the user was gone.
   *
   * Phase 1 also lays down a note on long returns (≥ 6 h) so the pet's
   * notebook accumulates evidence of separation history — this is the
   * raw material Phase 2's LLM will use to write "你这次出门有点久" lines.
   */
  async onActivity(now: number): Promise<void> {
    const { gapHours } = await touchAbsence(now);
    if (gapHours >= 6) {
      const mood = await readMood();
      await appendNote({
        ts: new Date(now).toISOString(),
        mood: mood.current,
        kind: 'observation',
        text: `主人回来了，离开了 ${gapHours.toFixed(1)} 小时。${gapHours >= 24 ? '这次有点久。' : ''}`,
      });
    }
  }

  /**
   * One tick of the heartbeat. Runs deterministically: drift mood,
   * grab observations, write at most one note. Phase 2 will extend
   * this with an LLM decision call that may emit a `speak` event to
   * the renderer; for now the pet is silent but actively noticing.
   */
  private async tick(reason: string): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.autonomy.enabled) {
      // Defensive: settings might have toggled off mid-flight.
      this.stop();
      return;
    }

    const now = Date.now();
    const snap = this.store.snapshot();
    // idleMinutes derived from absence record's lastActiveAt — falls back
    // to "never fed" → Infinity so the mood machine treats fresh installs
    // as quiet rather than busy.
    const { gapHours } = await touchAbsenceReadOnly(now);
    const idleMinutes = Number.isFinite(gapHours) ? gapHours * 60 : Number.POSITIVE_INFINITY;

    const drifted = await maybeDrift({
      now,
      idleMinutes,
      todayTokens: snap.today,
    });

    const observations = await gatherObservations(this.store);
    let didWrite = false;
    if (observations.length > 0) {
      const top = observations[0]!;
      const mood = drifted ?? await readMood();
      await appendNote({
        ts: new Date(now).toISOString(),
        mood: mood.current,
        kind: 'observation',
        text: top.data,
      });
      didWrite = true;
    }

    await writeLastTick({
      at: new Date(now).toISOString(),
      decision: drifted ? 'mood_shift' : didWrite ? 'observation' : 'silent',
    });

    console.log(
      `[nom][tick] ${reason} · mood=${drifted ? drifted.current : 'unchanged'}` +
      ` · observation=${observations[0]?.kind ?? 'none'}` +
      ` · today=${snap.today}` +
      ` · day=${todayKey()}`
    );
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
