import React from 'react';
import type { WeeklyReport } from '../../shared/types';
import { PixelPet } from './PixelPet';
import { formatInt, formatPercent, weekdayCn, weekRangeLabel, formatCompact, tierEn } from './format';

const C = {
  outer: '#0a0a0a',
  shell: '#d4b896',
  shellDeep: '#8d7548',
  shellInk: '#3d2f15',
  screen: '#9bbc0f',
  dark: '#0f380f',
  mid: '#306230',
  dim: '#5a8030',
  cheek: '#e89090',
  red: '#aa1111',
} as const;

const FONT_MONO = "'Press Start 2P', 'Courier New', 'Menlo', monospace";
const FONT_CN = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', sans-serif";

function peakQuip(weekday: string): string {
  return {
    Mon: '周一就这么拼 · 不要命了',
    Tue: '周二也在线 · 也是够拼',
    Wed: '周三熬夜了哦...',
    Thu: '周四爆发 · deadline 到了?',
    Fri: '周五还冲刺 · 辛苦你了',
    Sat: '周六也在线 · 佩服',
    Sun: '周日还写 · 该歇歇啦',
  }[weekday] || '本周表现稳定';
}

function levelLabelEn(cnLabel: string | null): string {
  if (!cnLabel) return 'MAX';
  const [tier, sub] = cnLabel.split(' ');
  return sub ? `${tierEn(tier!)}-${sub}` : tierEn(tier!);
}

function ProgressBar({ progress }: { progress: number }): React.JSX.Element {
  const cells = 24;
  const filled = Math.round(progress * cells);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells}, 1fr)`, gap: 3, height: 22 }}>
      {Array.from({ length: cells }, (_, i) => (
        <div
          key={i}
          style={{
            background: i < filled ? C.dark : 'transparent',
            border: `2px solid ${C.dark}`,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}

function DPad({ size = 56 }: { size?: number }): React.JSX.Element {
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <div style={{ position: 'absolute', top: size / 3, left: 0, right: 0, height: size / 3, background: C.dark, borderRadius: 4 }} />
      <div style={{ position: 'absolute', left: size / 3, top: 0, bottom: 0, width: size / 3, background: C.dark, borderRadius: 4 }} />
    </div>
  );
}

function ABButtons(): React.JSX.Element {
  const dot = {
    width: 38, height: 38, borderRadius: '50%',
    background: C.red,
    boxShadow: 'inset 0 -4px 0 rgba(0,0,0,0.35)',
  } as const;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', transform: 'rotate(-14deg)' }}>
      <div style={dot} />
      <div style={dot} />
    </div>
  );
}

export function GameBoyCard({ report }: { report: WeeklyReport }): React.JSX.Element {
  const peak = report.peakDay;
  const peakPct = peak && report.thisWeekTokens > 0 ? peak.tokens / report.thisWeekTokens : null;
  const lvCn = report.level.badge;
  const lvEn = `${tierEn(report.level.tier)}${report.level.subLevel ? '-' + report.level.subLevel : ''}`;
  const nextEn = levelLabelEn(report.nextLevelLabel);
  const nextCn = report.nextLevelLabel ?? '已达顶';
  const togoLabel = report.nextRankTokensAway != null
    ? `${formatCompact(report.nextRankTokensAway)} TOKENS TO GO`
    : 'AT MAX RANK';
  const maxBar = Math.max(...report.daily.map(d => d.tokens), 1);

  return (
    <div style={{
      width: 1080, height: 1080,
      background: C.outer,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT_MONO,
    }}>
      {/* Game Boy shell */}
      <div style={{
        width: 1000, height: 1000,
        background: C.shell,
        borderRadius: '24px 24px 24px 96px',
        boxShadow: `inset 0 -10px 0 ${C.shellDeep}, 0 12px 32px rgba(0,0,0,0.55)`,
        padding: '36px 40px 80px',
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        boxSizing: 'border-box',
        color: '#000',
      }}>
        {/* Shell header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: C.red }} />
            <div style={{ fontSize: 22, letterSpacing: 1, color: C.shellInk }}>nom POCKET</div>
          </div>
          <div style={{
            border: `2px solid ${C.shellInk}`, borderRadius: 4,
            padding: '5px 12px', fontSize: 14, letterSpacing: 1, color: C.shellInk,
          }}>
            WK {String(report.weekNumber).padStart(2, '0')} · {weekRangeLabel(report.weekStart, report.weekEnd)}
          </div>
        </div>

        {/* DOT MATRIX */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.shellInk, letterSpacing: 4, fontStyle: 'italic' }}>
            ◢ DOT MATRIX WITH STEREO SOUND ◣
          </div>
        </div>

        {/* Screen */}
        <div style={{
          flex: 1,
          background: C.screen,
          borderRadius: 14,
          padding: 28,
          color: C.dark,
          display: 'flex', flexDirection: 'column', gap: 16,
          boxShadow: 'inset 0 6px 18px rgba(0,0,0,0.25)',
        }}>
          {/* Screen header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18 }}>
            <div style={{ background: C.dark, color: C.screen, padding: '6px 12px', borderRadius: 4, letterSpacing: 1 }}>WEEKLY REPORT</div>
            <div style={{ background: C.dark, color: C.screen, padding: '6px 12px', borderRadius: 4, letterSpacing: 1 }}>
              P1 {report.petName.toUpperCase()}
            </div>
          </div>

          {/* Pet + identity */}
          <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
            <PixelPet size={140} bodyColor={C.dark} eyeColor={C.screen} cheekColor={C.cheek} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: 1, color: C.dark }}>{report.petName.toUpperCase()}</div>
                <div style={{ fontSize: 22, color: C.red }}>♥</div>
              </div>
              <div style={{ fontSize: 20, color: C.mid, marginTop: 6 }}>LV. {lvEn}</div>
              <div style={{ fontFamily: FONT_CN, fontSize: 20, color: C.dark, marginTop: 4 }}>{lvCn} · P1</div>
              <div style={{ fontSize: 14, color: C.mid, marginTop: 8, letterSpacing: 2 }}>STATUS · WELL-FED</div>
            </div>
          </div>

          {/* Progress bar */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.mid, marginBottom: 6, letterSpacing: 1 }}>
              <span>HP / RANK PROGRESS</span>
              <span>{formatPercent(report.level.progress, { digits: 0 })} → {nextEn}</span>
            </div>
            <ProgressBar progress={report.level.progress} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.mid, marginTop: 6 }}>
              <span style={{ fontFamily: FONT_CN }}>NEXT TIER · {nextCn}</span>
              <span>{togoLabel}</span>
            </div>
          </div>

          {/* Tokens main + side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 14 }}>
            <div style={{ border: `2px solid ${C.dark}`, borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 13, color: C.mid, letterSpacing: 2 }}>TOKENS · THIS WEEK</div>
              <div style={{ fontSize: 64, fontWeight: 700, color: C.dark, letterSpacing: -1, lineHeight: 1.1, marginTop: 4 }}>
                {formatInt(report.thisWeekTokens)}
              </div>
              <div style={{ fontSize: 14, color: C.mid, marginTop: 6 }}>
                {report.changePct == null ? '·' : report.changePct >= 0 ? '▲' : '▼'} {formatPercent(report.changePct, { showSign: true })} vs WK{String(report.weekNumber - 1).padStart(2, '0')} · {formatInt(report.lastWeekTokens)}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 12 }}>
              <div style={{ border: `2px solid ${C.dark}`, borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 12, color: C.mid, letterSpacing: 1 }}>PEAK · {peak ? peak.weekday.toUpperCase() : '—'}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: C.dark, marginTop: 2 }}>{peak ? formatInt(peak.tokens) : '—'}</div>
                <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>{peakPct ? `${(peakPct * 100).toFixed(0)}% OF WEEK` : ''}</div>
              </div>
              <div style={{ border: `2px solid ${C.dark}`, borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 12, color: C.mid, letterSpacing: 1 }}>FED COUNT</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: C.dark, marginTop: 2 }}>{report.fedDays} / 7</div>
                <div style={{ fontSize: 14, color: C.dark, marginTop: 4, letterSpacing: 2 }}>
                  {'★'.repeat(report.fedDays) + '·'.repeat(7 - report.fedDays)}
                </div>
              </div>
            </div>
          </div>

          {/* Daily chart */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.mid, marginBottom: 6, letterSpacing: 1 }}>
              <span>DAILY · WK {String(report.weekNumber).padStart(2, '0')}</span>
              <span>UNIT: PROPORTIONAL TO PEAK</span>
            </div>
            <div style={{ height: 140, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
              {report.daily.map((d) => {
                const h = (d.tokens / maxBar) * 100;
                const isPeak = peak && d.dateKey === peak.dateKey;
                return (
                  <div key={d.dateKey} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
                    <div style={{ fontSize: 10, color: C.mid, marginBottom: 3, letterSpacing: 0.5, height: 12 }}>
                      {d.tokens > 0 ? formatCompact(d.tokens) : ''}
                    </div>
                    <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
                      <div style={{
                        background: isPeak ? C.dark : C.mid,
                        width: '100%',
                        height: `${Math.max(h, d.tokens > 0 ? 6 : 0)}%`,
                        borderRadius: 3,
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: isPeak ? C.dark : C.mid, marginTop: 5, letterSpacing: 1, fontWeight: isPeak ? 700 : 400 }}>{d.weekday.toUpperCase()}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Notes */}
          <div style={{ borderTop: `2px dashed ${C.mid}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontFamily: FONT_CN, fontSize: 14, color: C.dark }}>
              ▶ 高峰日 · {peak ? weekdayCn(peak.weekday) : '—'}{peakPct ? ` · 占本周 ${(peakPct * 100).toFixed(0)}%` : ''}
            </div>
            <div style={{ fontFamily: FONT_CN, fontSize: 14, color: C.dark }}>
              ▶ {peak ? peakQuip(peak.weekday) : '本周表现稳定'}
            </div>
          </div>
        </div>

        {/* Shell footer */}
        <div style={{
          position: 'absolute', left: 40, right: 40, bottom: 18,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <DPad />
          <div style={{ fontSize: 11, color: C.shellInk, letterSpacing: 3, fontFamily: FONT_CN }}>
            <span style={{ fontFamily: FONT_MONO }}>● nom</span>　·　一只吃 token 的桌面宠物
          </div>
          <ABButtons />
        </div>
      </div>
    </div>
  );
}
