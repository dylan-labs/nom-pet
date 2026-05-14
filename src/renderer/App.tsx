import React, { useState, useEffect, useRef } from 'react';
import type { NomApi } from '../preload';
import type { DailyReport, DialogueContext, LevelInfo } from '../shared/types';
import { Sprite, type PetState } from './pet/Sprite';
import greetings from './dialogue/greeting.json';
import idleLines from './dialogue/idle.json';
import eatingLines from './dialogue/eating.json';
import milestoneTemplates from './dialogue/milestone.json';
import sleepLines from './dialogue/sleep.json';
import wakeLines from './dialogue/wake.json';
import sessionLines from './dialogue/session.json';

declare global {
  interface Window {
    nom: NomApi;
  }
}

const DRAG_THRESHOLD_PX = 4;
const SLEEP_AFTER_MS = 30 * 60 * 1000;
const SLEEP_CHECK_MS = 60 * 1000;
const MILESTONE_STEP = 1_000_000;
const EATING_DURATION_MS = 2500;
const GREETING_DELAY_MS = 800;

const WANDER_CHECK_MS = 15 * 1000;
const WANDER_CHANCE = 0.5;
const WANDER_COOLDOWN_MS = 20 * 1000;
const WANDER_DISTANCE_MIN = 60;
const WANDER_SPEED_PX_PER_SEC = 60;

function pickFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function pickGreeting(): string {
  const h = new Date().getHours();
  const bucket: keyof typeof greetings =
    h < 5  ? 'lateNight' :
    h < 9  ? 'earlyMorning' :
    h < 12 ? 'morning' :
    h < 14 ? 'noon' :
    h < 18 ? 'afternoon' :
    h < 22 ? 'evening' : 'night';
  return pickFrom(greetings[bucket]);
}

function formatMilestone(amount: number): string {
  return pickFrom(milestoneTemplates).replace('{amount}', formatTokens(amount));
}

function formatReportFallback(r: DailyReport): string {
  const parts = [`昨日 ${formatTokens(r.yesterdayTokens)}`];
  if (r.dayBeforeTokens > 0) {
    const pct = Math.round((r.yesterdayTokens - r.dayBeforeTokens) / r.dayBeforeTokens * 100);
    const arrow = pct >= 0 ? '↑' : '↓';
    parts.push(`vs 前日 ${arrow}${Math.abs(pct)}%`);
  }
  if (r.weekAvgTokens > 0) {
    parts.push(`周均 ${formatTokens(r.weekAvgTokens)}`);
  }
  return parts.join(' · ');
}

export function App() {
  const [bubble, setBubble] = useState<{ header: string; body: string; gold?: boolean; onClick?: () => void } | null>(null);
  const [today, setToday] = useState(0);
  const [, setCumulative] = useState(0);
  const [petState, setPetState] = useState<PetState>('idle');
  const [facing, setFacing] = useState<'left' | 'right'>('right');
  const [level, setLevel] = useState<LevelInfo | null>(null);

  const petStateRef = useRef<PetState>('idle');
  const lastActivityRef = useRef<number>(Date.now());
  const lastMilestoneRef = useRef<number>(0);
  const eatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanderRafRef = useRef<number | null>(null);
  const wanderEnabledRef = useRef<boolean>(true);

  function transition(next: PetState) {
    petStateRef.current = next;
    setPetState(next);
  }

  function showBubble(header: string, body: string, ms = 3000, opts?: { gold?: boolean; onClick?: () => void }) {
    setBubble({ header, body, gold: opts?.gold, onClick: opts?.onClick });
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), ms);
  }

  /**
   * Try the LLM-backed line first; fall back to the supplied template if
   * LLM is off / unreachable / returned junk. Fire-and-forget from event
   * handlers — `void smartBubble(...)`.
   */
  async function smartBubble(
    header: string,
    ctx: Omit<DialogueContext, 'hour'>,
    fallback: string,
    ms = 3000,
    opts?: { gold?: boolean },
  ) {
    const line = await window.nom.getDialogueLine({
      ...ctx,
      hour: new Date().getHours(),
    } as DialogueContext);
    showBubble(header, line ?? fallback, ms, opts);
  }

  function recordActivity() {
    lastActivityRef.current = Date.now();
  }

  function cancelWander() {
    if (wanderRafRef.current !== null) {
      cancelAnimationFrame(wanderRafRef.current);
      wanderRafRef.current = null;
    }
  }

  async function tryWander() {
    if (!wanderEnabledRef.current) return;
    if (petStateRef.current !== 'idle') return;
    if (Date.now() - lastActivityRef.current < WANDER_COOLDOWN_MS) return;
    if (Math.random() > WANDER_CHANCE) return;

    const bounds = await window.nom.getWindowBounds();
    if (!bounds || petStateRef.current !== 'idle') return;

    const { win, workArea } = bounds;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width  - win.w;
    const minY = workArea.y;
    const maxY = workArea.y + workArea.height - win.h;

    // Pick a target *anywhere* on screen, not just left/right at the bottom.
    // Bias Y toward the lower 60% so the pet "lives" down there (gravity
    // feel), but ~25% of trips climb up into the top 40% so it occasionally
    // perches near the top of the screen.
    const goingHigh = Math.random() < 0.25;
    const yLo = goingHigh ? minY : minY + (maxY - minY) * 0.4;
    const targetY = yLo + Math.random() * (maxY - yLo);
    const targetX = minX + Math.random() * (maxX - minX);

    const startX = win.x;
    const startY = win.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const dist = Math.hypot(dx, dy);
    if (dist < WANDER_DISTANCE_MIN) return; // skip tiny twitches

    const durationMs = (dist / WANDER_SPEED_PX_PER_SEC) * 1000;
    const startTime = performance.now();

    if      (dx >  1) setFacing('right');
    else if (dx < -1) setFacing('left');
    transition('walking');

    function step() {
      if (petStateRef.current !== 'walking') {
        wanderRafRef.current = null;
        return;
      }
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = Math.round(startX + dx * eased);
      const y = Math.round(startY + dy * eased);
      window.nom.moveWindowTo(x, y);
      if (t < 1) {
        wanderRafRef.current = requestAnimationFrame(step);
      } else {
        wanderRafRef.current = null;
        transition('idle');
        // "Perch" feel: if we landed in the top 40% of the screen, push the
        // cooldown out 12–30s so the pet stays up there instead of immediately
        // wandering back down. Reuses lastActivityRef as the next-wander gate.
        const arrivedY = y - workArea.y;
        if (arrivedY < workArea.height * 0.4) {
          const perchExtraMs = 12_000 + Math.random() * 18_000;
          lastActivityRef.current = Date.now() - WANDER_COOLDOWN_MS + perchExtraMs;
        }
      }
    }
    wanderRafRef.current = requestAnimationFrame(step);
  }

  function onPetMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    cancelWander();
    recordActivity();

    const startX = e.screenX;
    const startY = e.screenY;
    let dragging = false;
    let lastX = startX;
    window.nom.dragBegin(startX, startY);

    function onMove(ev: MouseEvent) {
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragging = true;
        if (eatingTimerRef.current) {
          clearTimeout(eatingTimerRef.current);
          eatingTimerRef.current = null;
        }
        transition('dragging');
      }
      if (dragging) {
        const stepDx = ev.screenX - lastX;
        if (stepDx > 1) setFacing('right');
        else if (stepDx < -1) setFacing('left');
        lastX = ev.screenX;
        window.nom.dragMove(ev.screenX, ev.screenY);
      }
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.nom.dragEnd();
      if (dragging) {
        transition('idle');
        recordActivity();
      } else {
        onPetClick();
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onPetClick() {
    if (petStateRef.current === 'sleeping') {
      transition('idle');
      void smartBubble('醒来', { trigger: 'wake', level: level ?? undefined }, pickFrom(wakeLines), 2500);
    } else {
      // Briefly show talking frame while bubble is up.
      transition('talking');
      setTimeout(() => {
        if (petStateRef.current === 'talking') transition('idle');
      }, 1200);
      void smartBubble(
        '聊天',
        { trigger: 'idle-click', todayTokens: today, level: level ?? undefined },
        pickFrom(idleLines),
      );
    }
  }

  useEffect(() => {
    void window.nom.getState().then((s) => {
      setToday(s.today);
      setCumulative(s.cumulative);
      lastMilestoneRef.current = Math.floor(s.today / MILESTONE_STEP) * MILESTONE_STEP;
    });
    void window.nom.getLevel().then(setLevel);
    const t = setTimeout(() => showBubble('打招呼', pickGreeting(), 3000), GREETING_DELAY_MS);

    // Daily-report check: ~5 seconds after greeting (lets the user settle in
    // before we hit them with a recap). If the report is pending and there's
    // actually data for yesterday, show it via smartBubble (so LLM-enabled
    // users get a sassy line, others get a templated fallback).
    const reportTimer = setTimeout(() => { void maybeShowDailyReport(); }, GREETING_DELAY_MS + 5000);

    return () => {
      clearTimeout(t);
      clearTimeout(reportTimer);
    };
  }, []);

  async function maybeShowDailyReport() {
    const { pending, report } = await window.nom.getDailyReport();
    if (!pending || !report) return;
    void window.nom.markDailyReportShown();
    void smartBubble(
      '每日小结',
      { trigger: 'daily-report', report } as Omit<DialogueContext, 'hour'>,
      formatReportFallback(report),
      8000,
    );
  }

  useEffect(() => {
    return window.nom.onLevelUp((e) => {
      setLevel(e.to);
      cancelWander();
      transition('talking');
      setTimeout(() => {
        if (petStateRef.current === 'talking') transition('idle');
      }, 1500);
      const header = e.tierJumped ? `🎉 进入 ${e.to.tier}` : '升级';
      const fallback = e.tierJumped
        ? `从 ${e.from.tier} 升到 ${e.to.tier} 啦！`
        : `升到 ${e.to.badge} 啦`;
      void smartBubble(header, {
        trigger: 'level-up',
        level: e.to,
        levelUp: e,
      } as Omit<DialogueContext, 'hour'>, fallback, e.tierJumped ? 5000 : 3500, { gold: e.tierJumped });
    });
  }, []);

  // Silent recovery: lifetime scan in main process restored cumulative
  // from canonical transcript files (e.g. user deleted ~/.nom/). Update
  // numbers in place without a bubble or animation.
  useEffect(() => {
    return window.nom.onStateReconciled((e) => {
      setCumulative(e.snapshot.cumulative);
      setToday(e.snapshot.today);
      setLevel(e.level);
    });
  }, []);

  // Journal landed on disk — pop a clickable bubble so the user knows
  // it exists. Without this, the file just appears silently and most
  // users would never discover the feature.
  useEffect(() => {
    return window.nom.journal.onCreated(() => {
      showBubble(
        '日记本',
        '昨天的日记写完了，点我看看？',
        4500,
        { onClick: () => window.nom.journal.open() },
      );
    });
  }, []);

  useEffect(() => {
    return window.nom.onSession((e) => {
      if (e.kind !== 'start') return;
      cancelWander();
      const wasSleeping = petStateRef.current === 'sleeping';
      if (wasSleeping || petStateRef.current === 'walking') {
        transition('idle');
      }
      recordActivity();
      void smartBubble('新会话', { trigger: 'session-start' }, pickFrom(sessionLines), 2800);
    });
  }, []);

  useEffect(() => {
    const unsub = window.nom.onTokens((e) => {
      const wasSleeping = petStateRef.current === 'sleeping';
      cancelWander();
      transition('eating');
      if (eatingTimerRef.current) clearTimeout(eatingTimerRef.current);
      eatingTimerRef.current = setTimeout(() => transition('idle'), EATING_DURATION_MS);
      recordActivity();

      setToday(e.snapshot.today);
      setCumulative(e.snapshot.cumulative);

      const newMilestone = Math.floor(e.snapshot.today / MILESTONE_STEP) * MILESTONE_STEP;
      const milestoneJustHit = newMilestone > lastMilestoneRef.current && newMilestone > 0;
      if (milestoneJustHit) lastMilestoneRef.current = newMilestone;

      if (wasSleeping) {
        void smartBubble('醒来', { trigger: 'wake' }, pickFrom(wakeLines), 2500);
      } else if (milestoneJustHit) {
        void smartBubble(
          '里程碑',
          { trigger: 'milestone', amount: newMilestone },
          formatMilestone(newMilestone),
          3000,
        );
      } else if (Math.random() < 0.35) {
        void smartBubble(
          '在吃',
          { trigger: 'eating', delta: e.delta, todayTokens: e.snapshot.today },
          pickFrom(eatingLines),
          2000,
        );
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (petStateRef.current !== 'idle') return;
      if (Date.now() - lastActivityRef.current >= SLEEP_AFTER_MS) {
        transition('sleeping');
        showBubble('打盹', pickFrom(sleepLines), 2500);
      }
    }, SLEEP_CHECK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void window.nom.getSettings().then((s) => {
      wanderEnabledRef.current = s.wanderEnabled;
    });
    const unsub = window.nom.onSettingsChanged((s) => {
      wanderEnabledRef.current = s.wanderEnabled;
      if (!s.wanderEnabled) {
        cancelWander();
        if (petStateRef.current === 'walking') transition('idle');
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = setInterval(() => { void tryWander(); }, WANDER_CHECK_MS);
    return () => {
      clearInterval(id);
      cancelWander();
    };
  }, []);


  const lastDateRef = useRef(new Date().toDateString());
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date().toDateString();
      if (now !== lastDateRef.current) {
        lastDateRef.current = now;
        lastMilestoneRef.current = 0;
        void window.nom.getState().then((s) => {
          setToday(s.today);
          setCumulative(s.cumulative);
        });
      }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="container">
      {bubble && (
        <div
          className={`bubble${bubble.gold ? ' bubble--gold' : ''}${bubble.onClick ? ' bubble--clickable' : ''}`}
          onClick={bubble.onClick}
          role={bubble.onClick ? 'button' : undefined}
        >
          <div className="bubble-header">{bubble.header}</div>
          <div className="bubble-body">{bubble.body}</div>
        </div>
      )}
      <div
        className={`pet pet--${petState}`}
        onMouseDown={onPetMouseDown}
      >
        <Sprite state={petState} facing={facing} />
      </div>
      <div className="status">
        {level && (
          <div className={`badge badge--${tierClass(level.tier)}`} title={`累计 ${formatTokens(level.threshold)}+`}>
            <span className="badge-text">{level.badge}</span>
            {level.nextThreshold !== null && (
              <span className="badge-progress" style={{ width: `${Math.round(level.progress * 100)}%` }} />
            )}
          </div>
        )}
        {today > 0 && <div className="counter">today · {formatTokens(today)}</div>}
      </div>
    </div>
  );
}

function tierClass(tier: string): string {
  switch (tier) {
    case '新手': return 'rookie';
    case '学徒': return 'apprentice';
    case '行家': return 'expert';
    case '大师': return 'master';
    case '宗师': return 'grandmaster';
    case '传说': return 'legend';
    case '战神': return 'godlike';
    default:     return 'rookie';
  }
}
