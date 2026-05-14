import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { NomApi } from '../../preload';
import type { JournalEntry } from '../../shared/types';

declare global {
  interface Window {
    nom: NomApi;
  }
}

// Mirror of card/GameBoyCard.tsx so the viewer reads as the same
// "physical device" — same shell colour, same LCD green, same red
// accents. Any tweak here should land in the card too (and vice versa).
const C = {
  outer:      '#0a0a0a',
  shell:      '#d4b896',
  shellDeep:  '#8d7548',
  shellInk:   '#3d2f15',
  screen:     '#9bbc0f',
  dark:       '#0f380f',
  mid:        '#306230',
  red:        '#aa1111',
} as const;

const FONT_MONO = "'Press Start 2P', 'Courier New', 'Menlo', monospace";
const FONT_CN   = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', sans-serif";

const WEEKDAY_CN: Record<string, string> = {
  Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四',
  Fri: '周五', Sat: '周六', Sun: '周日',
};

function shortDate(key: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${Number(m[1])}/${Number(m[2])}`;
}

function longDate(key: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${Number(m[1])}月${Number(m[2])}日`;
}

/**
 * The Game Boy D-pad, with left/right halves wired to navigation. Up
 * and down stay decorative — there's no sensible mapping for them in a
 * one-axis journal viewer, and faking semantics would just confuse.
 */
function DPad({ onLeft, onRight, leftEnabled, rightEnabled }: {
  onLeft: () => void;
  onRight: () => void;
  leftEnabled: boolean;
  rightEnabled: boolean;
}): React.JSX.Element {
  const size = 58;
  const arm = size / 3;
  const baseArm: React.CSSProperties = {
    position: 'absolute',
    background: C.dark,
    borderRadius: 4,
  };
  // Clickable hot-spots are absolutely positioned over the cross so the
  // dark "arm" graphic stays a single piece visually.
  const hotspot = (extra: React.CSSProperties, enabled: boolean): React.CSSProperties => ({
    position: 'absolute',
    cursor: enabled ? 'pointer' : 'default',
    WebkitAppRegion: 'no-drag',
    opacity: enabled ? 1 : 0.35,
    ...extra,
  } as React.CSSProperties);
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      {/* Horizontal arm */}
      <div style={{ ...baseArm, top: arm, left: 0, right: 0, height: arm }} />
      {/* Vertical arm */}
      <div style={{ ...baseArm, left: arm, top: 0, bottom: 0, width: arm }} />
      {/* Center dimple */}
      <div style={{
        position: 'absolute',
        left: arm + 4, top: arm + 4,
        width: arm - 8, height: arm - 8,
        background: C.shellInk,
        borderRadius: 2,
      }} />
      {/* Click zones */}
      <div
        onClick={leftEnabled ? onLeft : undefined}
        style={hotspot({ left: 0, top: arm, width: arm, height: arm }, leftEnabled)}
        title="更新一天（←）"
      />
      <div
        onClick={rightEnabled ? onRight : undefined}
        style={hotspot({ right: 0, top: arm, width: arm, height: arm }, rightEnabled)}
        title="更早一天（→）"
      />
    </div>
  );
}

/**
 * Pair of red round buttons, rotated to match the iconic GB layout.
 * A = the most common positive action ("read"/"refresh"), B = cancel
 * ("close window" since we're frameless). Labels float underneath in
 * the shell ink colour so the chrome stays readable but unobtrusive.
 */
function ABButtons({ onA, onB }: { onA?: () => void; onB?: () => void }): React.JSX.Element {
  const dot: React.CSSProperties = {
    width: 36, height: 36, borderRadius: '50%',
    background: C.red,
    boxShadow: 'inset 0 -4px 0 rgba(0,0,0,0.35)',
    cursor: onA || onB ? 'pointer' : 'default',
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties;
  const label: React.CSSProperties = {
    position: 'absolute',
    bottom: -14, left: '50%', transform: 'translateX(-50%)',
    fontFamily: FONT_MONO, fontSize: 9, color: C.shellInk, letterSpacing: 1,
  };
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', transform: 'rotate(-14deg)' }}>
      <div style={{ position: 'relative' }}>
        <div style={dot} onClick={onB} title="关闭（Esc）" />
        <span style={label}>B</span>
      </div>
      <div style={{ position: 'relative' }}>
        <div style={dot} onClick={onA} title="重写当前日记" />
        <span style={label}>A</span>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  // Sorted desc — index 0 is the newest journal on disk.
  const [dates, setDates] = useState<string[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const loadingRef = useRef(false);

  // Initial load: list + newest entry.
  useEffect(() => {
    void (async () => {
      const list = await window.nom.journal.list();
      setDates(list);
      if (list.length > 0) {
        const first = await window.nom.journal.get(list[0]!);
        setEntry(first);
      }
    })();
  }, []);

  const loadAt = useCallback(async (idx: number) => {
    if (!dates || idx < 0 || idx >= dates.length) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const e = await window.nom.journal.get(dates[idx]!);
      setEntry(e);
      setCursor(idx);
    } finally {
      loadingRef.current = false;
    }
  }, [dates]);

  // Keyboard: ← newer (idx−1), → older (idx+1), Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { window.close(); return; }
      if (!dates || dates.length === 0) return;
      if (e.key === 'ArrowLeft')       void loadAt(cursor - 1);
      else if (e.key === 'ArrowRight') void loadAt(cursor + 1);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dates, cursor, loadAt]);

  const newerIdx = cursor - 1;
  const olderIdx = cursor + 1;
  const hasNewer = dates !== null && newerIdx >= 0;
  const hasOlder = dates !== null && olderIdx < dates.length;
  const hasAny   = dates !== null && dates.length > 0 && entry !== null;

  // Regenerate "today's yesterday" — only enabled when the displayed
  // entry IS yesterday (the only date the orchestrator can rebuild
  // from current state). Quietly disabled otherwise.
  const todayJournalDate = dates?.[0];
  const onRegenerate = useCallback(async () => {
    if (!entry || !todayJournalDate || entry.date !== todayJournalDate) return;
    const fresh = await window.nom.journal.regenerate(entry.date);
    if (fresh) setEntry(fresh);
  }, [entry, todayJournalDate]);

  // ── Layout ──────────────────────────────────────────────────────────

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: C.outer,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      WebkitAppRegion: 'drag',
      fontFamily: FONT_MONO,
      overflow: 'hidden',
    } as React.CSSProperties}>
      {/* Game Boy shell — iconic asymmetric border-radius for the
          bottom-left curve, inset bottom shadow to fake the bevel. */}
      <div style={{
        width: 392, height: 572,
        background: C.shell,
        borderRadius: '16px 16px 16px 56px',
        boxShadow: `inset 0 -6px 0 ${C.shellDeep}, 0 8px 22px rgba(0,0,0,0.6)`,
        padding: '14px 16px 18px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        color: '#000',
        position: 'relative',
      }}>
        {/* Shell header — red power LED + brand mark + week chip */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: C.red,
              boxShadow: '0 0 4px rgba(170,17,17,0.7)',
            }} />
            <div style={{ fontSize: 10, letterSpacing: 1, color: C.shellInk }}>nom POCKET</div>
          </div>
          <div style={{
            border: `1.5px solid ${C.shellInk}`, borderRadius: 3,
            padding: '2px 7px', fontSize: 8, letterSpacing: 1, color: C.shellInk,
          }}>
            {entry ? `DAY ${shortDate(entry.date)}` : 'JOURNAL'}
          </div>
        </div>

        {/* DOT MATRIX strip, matches the card */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 7, color: C.shellInk, letterSpacing: 3, fontStyle: 'italic' }}>
            ◢ DOT MATRIX · DAILY JOURNAL ◣
          </div>
        </div>

        {/* Screen — green LCD with inset shadow */}
        <div style={{
          flex: 1,
          background: C.screen,
          borderRadius: 8,
          padding: '12px 14px',
          color: C.dark,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          boxShadow: 'inset 0 4px 12px rgba(0,0,0,0.25)',
          minHeight: 0,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>
          {!hasAny ? (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              textAlign: 'center', padding: 20, color: C.mid,
              fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 1, lineHeight: 1.8,
            }}>
              我还没开始记日记呢…<br />再用我几天吧
            </div>
          ) : (
            <>
              {/* Screen top chips — JOURNAL on left, pet identity on right */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, letterSpacing: 1 }}>
                <div style={{ background: C.dark, color: C.screen, padding: '3px 7px', borderRadius: 2 }}>
                  JOURNAL
                </div>
                <div style={{ background: C.dark, color: C.screen, padding: '3px 7px', borderRadius: 2 }}>
                  P1 · {entry!.petName.toUpperCase()}
                </div>
              </div>

              {/* Date row + weather emoji */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: `1.5px dashed ${C.mid}`, paddingBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: C.dark, letterSpacing: 1, lineHeight: 1 }}>
                    {longDate(entry!.date)}
                  </div>
                  <div style={{ fontFamily: FONT_CN, fontSize: 12, color: C.mid }}>
                    {WEEKDAY_CN[entry!.weekday] ?? entry!.weekday}
                  </div>
                </div>
                <div style={{ fontSize: 22, lineHeight: 1 }}>{entry!.weather}</div>
              </div>

              {/* Body — Chinese sans so the prose reads, on the green LCD */}
              <div style={{
                flex: 1, overflowY: 'auto', overflowX: 'hidden',
                fontFamily: FONT_CN, fontSize: 13, lineHeight: 1.85, color: C.dark,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                paddingRight: 4,
              }}>
                {entry!.body}
              </div>

              {/* Pager — date label left/right, position center */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderTop: `1.5px dashed ${C.mid}`,
                paddingTop: 6, fontSize: 9, letterSpacing: 1, color: C.mid,
              }}>
                <span>{hasNewer ? `◀ ${shortDate(dates![newerIdx]!)}` : '◀ ——'}</span>
                <span style={{ fontFamily: FONT_CN }}>{cursor + 1} / {dates!.length}</span>
                <span>{hasOlder ? `${shortDate(dates![olderIdx]!)} ▶` : '—— ▶'}</span>
              </div>
            </>
          )}
        </div>

        {/* Shell footer — D-pad, brand line, A/B buttons */}
        <div style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 60,
        }}>
          <DPad
            onLeft={() => void loadAt(newerIdx)}
            onRight={() => void loadAt(olderIdx)}
            leftEnabled={hasNewer}
            rightEnabled={hasOlder}
          />
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            color: C.shellInk, letterSpacing: 2, lineHeight: 1.3,
          }}>
            <span style={{ fontSize: 9 }}>● nom</span>
            <span style={{ fontFamily: FONT_CN, fontSize: 9 }}>一只吃 token 的桌面宠物</span>
          </div>
          <ABButtons
            onA={hasAny && entry?.date === todayJournalDate ? onRegenerate : undefined}
            onB={() => window.close()}
          />
        </div>
      </div>
    </div>
  );
}
