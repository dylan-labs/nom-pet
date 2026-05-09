import React, { useState, useEffect, useRef } from 'react';
import type { NomApi } from '../preload';
import type { DialogueContext, LevelInfo } from '../shared/types';
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
const PERCH_ON_WINDOW_CHANCE = 0.4;  // chance of targeting a real window's top edge instead of free 2D

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

export function App() {
  const [bubble, setBubble] = useState<{ header: string; body: string; gold?: boolean } | null>(null);
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

  function showBubble(header: string, body: string, ms = 3000, opts?: { gold?: boolean }) {
    setBubble({ header, body, gold: opts?.gold });
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

    // Two destination strategies. PERCH_ON_WINDOW_CHANCE of the time we
    // pick a real on-screen app window and aim for its top edge — that's
    // how the pet appears to "stand on top of your VS Code". Otherwise we
    // do a free 2D wander, with a 25% chance of going into the upper 40%
    // of the screen (so the pet roams everywhere, not just along edges).
    let targetX: number;
    let targetY: number;
    let perchedOnOwner: string | null = null;

    if (Math.random() < PERCH_ON_WINDOW_CHANCE) {
      const windows = (await window.nom.listVisibleWindows()).filter(
        (w) => w.w >= win.w * 1.5 && w.y > minY + 40,  // wide enough + not flush against menu bar
      );
      if (windows.length > 0) {
        const target = windows[Math.floor(Math.random() * windows.length)]!;
        // Land somewhere along the window's top edge, slightly inset from
        // either end so the pet sits on top of the actual frame.
        const inset = Math.min(40, target.w * 0.15);
        targetX = Math.round(
          target.x + inset + Math.random() * (target.w - 2 * inset - win.w),
        );
        targetY = Math.round(target.y - win.h);
        perchedOnOwner = target.owner;
      } else {
        // No suitable window — fall through to free wander
        const goingHigh = Math.random() < 0.25;
        const yLo = goingHigh ? minY : minY + (maxY - minY) * 0.4;
        targetY = yLo + Math.random() * (maxY - yLo);
        targetX = minX + Math.random() * (maxX - minX);
      }
    } else {
      const goingHigh = Math.random() < 0.25;
      const yLo = goingHigh ? minY : minY + (maxY - minY) * 0.4;
      targetY = yLo + Math.random() * (maxY - yLo);
      targetX = minX + Math.random() * (maxX - minX);
    }

    // Clamp to work area in case we picked off-screen.
    targetX = Math.max(minX, Math.min(targetX, maxX));
    targetY = Math.max(minY, Math.min(targetY, maxY));

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
        // "Perch" feel via lastActivityRef as the next-wander gate.
        // - Landed on a real window's top edge → 30–60s (deliberate spot)
        // - Otherwise in upper 40% of screen → 12–30s
        // - Anywhere else → no extra hold (regular wander cadence)
        let perchExtraMs = 0;
        const arrivedY = y - workArea.y;
        if (perchedOnOwner) {
          perchExtraMs = 30_000 + Math.random() * 30_000;
          console.log(`[nom][wander] perched on ${perchedOnOwner}`);
        } else if (arrivedY < workArea.height * 0.4) {
          perchExtraMs = 12_000 + Math.random() * 18_000;
        }
        if (perchExtraMs > 0) {
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
    return () => clearTimeout(t);
  }, []);

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
        <div className={`bubble${bubble.gold ? ' bubble--gold' : ''}`}>
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
