import React, { useState, useEffect, useRef } from 'react';
import type { NomApi } from '../preload';
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
const WANDER_DISTANCE_MAX = 220;
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

export function App() {
  const [bubble, setBubble] = useState<string | null>(null);
  const [today, setToday] = useState(0);
  const [, setCumulative] = useState(0);
  const [petState, setPetState] = useState<PetState>('idle');
  const [facing, setFacing] = useState<'left' | 'right'>('right');
  const [thinkingCount, setThinkingCount] = useState(0);
  const thinkingSetRef = useRef(new Set<string>());

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

  function showBubble(line: string, ms = 2500) {
    setBubble(line);
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), ms);
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
    const roomLeft = win.x - workArea.x;
    const roomRight = workArea.x + workArea.width - (win.x + win.w);
    if (roomLeft < WANDER_DISTANCE_MIN && roomRight < WANDER_DISTANCE_MIN) return;

    let dir: 'left' | 'right';
    if (roomLeft < WANDER_DISTANCE_MIN) dir = 'right';
    else if (roomRight < WANDER_DISTANCE_MIN) dir = 'left';
    else dir = Math.random() < 0.5 ? 'left' : 'right';

    const room = dir === 'right' ? roomRight : roomLeft;
    const dist = Math.min(
      room,
      WANDER_DISTANCE_MIN + Math.random() * (WANDER_DISTANCE_MAX - WANDER_DISTANCE_MIN),
    );
    const startX = win.x;
    const targetX = dir === 'right' ? startX + dist : startX - dist;
    const durationMs = (dist / WANDER_SPEED_PX_PER_SEC) * 1000;
    const startTime = performance.now();

    setFacing(dir);
    transition('walking');

    function step() {
      if (petStateRef.current !== 'walking') {
        wanderRafRef.current = null;
        return;
      }
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = Math.round(startX + (targetX - startX) * eased);
      window.nom.moveWindowTo(x, win.y);
      if (t < 1) {
        wanderRafRef.current = requestAnimationFrame(step);
      } else {
        wanderRafRef.current = null;
        transition('idle');
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
      showBubble(pickFrom(wakeLines), 2000);
    } else {
      // Briefly show talking frame while bubble is up.
      transition('talking');
      setTimeout(() => {
        if (petStateRef.current === 'talking') transition('idle');
      }, 1200);
      showBubble(pickFrom(idleLines));
    }
  }

  useEffect(() => {
    void window.nom.getState().then((s) => {
      setToday(s.today);
      setCumulative(s.cumulative);
      lastMilestoneRef.current = Math.floor(s.today / MILESTONE_STEP) * MILESTONE_STEP;
    });
    const t = setTimeout(() => showBubble(pickGreeting(), 3000), GREETING_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    return window.nom.onThinking((e) => {
      const set = thinkingSetRef.current;
      if (e.kind === 'start') set.add(e.sessionId);
      else set.delete(e.sessionId);
      setThinkingCount(set.size);
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
      showBubble(pickFrom(sessionLines), 2500);
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
        showBubble(pickFrom(wakeLines), 2500);
      } else if (milestoneJustHit) {
        showBubble(formatMilestone(newMilestone), 2500);
      } else if (Math.random() < 0.35) {
        showBubble(pickFrom(eatingLines), 1800);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (petStateRef.current !== 'idle') return;
      if (Date.now() - lastActivityRef.current >= SLEEP_AFTER_MS) {
        transition('sleeping');
        showBubble(pickFrom(sleepLines), 2500);
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
      {bubble && <div className="bubble">{bubble}</div>}
      <div
        className={`pet pet--${petState}`}
        onMouseDown={onPetMouseDown}
      >
        <Sprite state={petState} facing={facing} />
        {thinkingCount > 0 && (
          <div className="thinking">
            <span className="thinking-tag">Claude</span>
            <span className="thinking-text">
              思考中<span className="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
            </span>
          </div>
        )}
      </div>
      {today > 0 && (
        <div className="counter">today · {formatTokens(today)}</div>
      )}
    </div>
  );
}
