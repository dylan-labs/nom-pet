import React from 'react';
import type { WeeklyReport } from '../../shared/types';
import { PixelPet } from './PixelPet';
import { formatInt, formatPercent, weekdayCn, formatCompact, tierEn } from './format';

const C = {
  bg: '#000000',
  green: '#00ff66',
  greenBright: '#00ff99',
  greenDim: '#00aa55',
  greenFaint: '#155a33',
  amber: '#ffb000',
  white: '#e8ffe8',
} as const;

const FONT = "'IBM Plex Mono', 'SF Mono', 'Menlo', 'Consolas', monospace";
const FONT_CN = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'IBM Plex Mono', sans-serif";

function levelLabelEnLower(cnLabel: string | null): string {
  if (!cnLabel) return 'max';
  const [tier, sub] = cnLabel.split(' ');
  return sub ? `${tierEn(tier!).toLowerCase()} ${sub}` : tierEn(tier!).toLowerCase();
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '0d 0h 0m';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

function asciiBar(progress: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round(progress * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function Box({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{
      position: 'relative',
      borderTop: `1px solid ${C.green}`,
      borderBottom: `1px solid ${C.green}`,
      padding: '18px 14px 14px',
      marginTop: 12,
    }}>
      <div style={{
        position: 'absolute', top: -10, left: 14,
        background: C.bg, padding: '0 8px',
        color: C.amber, fontSize: 14, letterSpacing: 1,
      }}>
        [ {title} ]
      </div>
      {children}
    </div>
  );
}

function KvRow({ k, v, accent }: { k: string; v: React.ReactNode; accent?: boolean }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
      <div style={{ width: 110, color: C.greenDim, fontSize: 18 }}>{k}</div>
      <div style={{ color: C.green, fontSize: 18 }}>→</div>
      <div style={{ color: accent ? C.greenBright : C.green, fontSize: 18 }}>{v}</div>
    </div>
  );
}

export function TerminalCard({ report }: { report: WeeklyReport }): React.JSX.Element {
  const peak = report.peakDay;
  const peakPct = peak && report.thisWeekTokens > 0 ? peak.tokens / report.thisWeekTokens : null;
  const lvCn = report.level.badge;
  const lvEnLower = `${tierEn(report.level.tier).toLowerCase()}${report.level.subLevel ? ' ' + report.level.subLevel : ''}`;
  const nextEnLower = levelLabelEnLower(report.nextLevelLabel);
  const togoStr = report.nextRankTokensAway != null
    ? `(+${formatCompact(report.nextRankTokensAway)} tokens)`
    : '(at max rank)';
  const maxBar = Math.max(...report.daily.map(d => d.tokens), 1);
  const prevWeek = String(report.weekNumber - 1).padStart(2, '0');
  const wkLabel = `wk${String(report.weekNumber).padStart(2, '0')}.${report.year}`;
  const slug = report.petName.toLowerCase();

  return (
    <div style={{
      width: 1080, height: 1080,
      background: C.bg,
      color: C.green,
      fontFamily: FONT,
      padding: '44px 50px',
      boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* prompt line */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18 }}>
        <div>
          <span style={{ color: C.greenBright }}>●</span>{' '}
          <span style={{ color: C.green }}>nom@desktop</span>
          <span style={{ color: C.greenDim }}>:</span>
          <span style={{ color: C.greenBright }}>~/{slug}</span>{' '}
          <span style={{ color: C.amber }}>$</span>
        </div>
        <div style={{ color: C.greenDim, fontSize: 14, paddingTop: 4 }}>
          {wkLabel} <span style={{ color: C.greenFaint }}>·</span> uptime {formatUptime(report.uptimeMs)}
        </div>
      </div>

      {/* command */}
      <div style={{ fontSize: 18, marginTop: 2 }}>
        <span style={{ color: C.amber }}>$</span>{' '}
        <span style={{ color: C.green }}>nom --weekly --pet={slug} --format=card</span>
      </div>

      {/* PET box */}
      <Box title={`PET · ${report.petName.toUpperCase()}`}>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
          <PixelPet size={130} bodyColor={C.green} eyeColor={C.bg} cheekColor={C.greenFaint} />
          <div style={{ flex: 1 }}>
            <KvRow k="name" v={<span style={{ color: C.greenBright }}>{report.petName}</span>} />
            <KvRow k="rank" v={
              <span><span style={{ color: C.greenBright }}>{lvEnLower}</span> <span style={{ color: C.greenDim }}>/</span> <span style={{ fontFamily: FONT_CN }}>{lvCn}</span></span>
            } />
            <KvRow k="progress" v={
              <span>
                <span style={{ color: C.greenBright, letterSpacing: 1 }}>[{asciiBar(report.level.progress)}]</span>{' '}
                <span style={{ color: C.greenBright }}>{formatPercent(report.level.progress, { digits: 0 })}</span>
              </span>
            } />
            <KvRow k="next_tier" v={
              <span><span style={{ color: C.greenBright }}>{nextEnLower}</span> <span style={{ color: C.greenDim }}>{togoStr}</span></span>
            } />
            <KvRow k="status" v={<span><span style={{ color: C.greenBright }}>fed</span> <span style={{ color: C.greenDim }}>·</span> purring</span>} />
          </div>
        </div>
      </Box>

      {/* TOKENS box */}
      <Box title={`TOKENS · WK ${String(report.weekNumber).padStart(2, '0')}`}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <div style={{ fontSize: 96, fontWeight: 600, color: C.greenBright, lineHeight: 1, letterSpacing: -2 }}>
            {formatInt(report.thisWeekTokens)}
          </div>
          <div style={{ fontSize: 18, color: C.greenDim, paddingBottom: 8 }}>tokens consumed</div>
        </div>
        <div style={{ fontSize: 16, color: C.green, marginTop: 8 }}>
          <span style={{ color: report.changePct == null ? C.greenDim : report.changePct >= 0 ? C.amber : C.greenDim }}>
            {report.changePct == null ? '·' : report.changePct >= 0 ? '▲' : '▼'}
          </span>{' '}
          <span style={{ color: C.greenBright }}>{formatPercent(report.changePct, { showSign: true })}</span>{' '}
          <span style={{ color: C.greenFaint }}>//</span> wk{prevWeek} <span style={{ color: C.greenFaint }}>·</span> {formatInt(report.lastWeekTokens)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginTop: 18 }}>
          <div>
            <div style={{ fontSize: 13, color: C.greenDim, letterSpacing: 1 }}>PEAK DAY</div>
            <div style={{ fontSize: 26, color: C.greenBright, marginTop: 2 }}>
              {peak ? peak.weekday : '—'} <span style={{ color: C.greenDim }}>·</span> {peak ? formatInt(peak.tokens) : '—'}
            </div>
            <div style={{ fontSize: 13, color: C.greenFaint, marginTop: 2 }}>
              {peakPct ? `// ${(peakPct * 100).toFixed(0)}% of week` : ''}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: C.greenDim, letterSpacing: 1 }}>FED STREAK</div>
            <div style={{ fontSize: 26, color: C.greenBright, marginTop: 2 }}>
              {report.fedDays} <span style={{ color: C.greenDim }}>/</span> 7 days
            </div>
            <div style={{ fontSize: 13, color: C.greenFaint, marginTop: 2 }}>
              {report.fedDays === 7 ? '// uninterrupted' : `// ${7 - report.fedDays} day${7 - report.fedDays > 1 ? 's' : ''} skipped`}
            </div>
          </div>
        </div>
      </Box>

      {/* DAILY box */}
      <Box title="DAILY">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {report.daily.map((d) => {
            const w = (d.tokens / maxBar) * 100;
            const isPeak = peak && d.dateKey === peak.dateKey;
            return (
              <div key={d.dateKey} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 16 }}>
                <div style={{ width: 36, color: isPeak ? C.greenBright : C.greenDim, fontWeight: isPeak ? 600 : 400 }}>{d.weekday}</div>
                <div style={{ flex: 1, height: 14, background: 'rgba(0,255,102,0.08)', position: 'relative' }}>
                  <div style={{
                    position: 'absolute', top: 0, left: 0, bottom: 0,
                    width: `${w}%`,
                    background: isPeak ? C.greenBright : C.green,
                  }} />
                </div>
                <div style={{ width: 90, textAlign: 'right', color: isPeak ? C.greenBright : C.green, fontWeight: isPeak ? 600 : 400 }}>
                  {formatInt(d.tokens)}
                </div>
              </div>
            );
          })}
        </div>
      </Box>

      {/* NOTES box */}
      <Box title="NOTES">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 15, fontFamily: FONT_CN, color: C.green }}>
          <div>
            <span style={{ color: C.amber, fontFamily: FONT }}>{'>'}</span>{' '}
            高峰日 · {peak ? weekdayCn(peak.weekday) : '—'}
            {peakPct ? ` · 占本周 ${(peakPct * 100).toFixed(0)}%` : ''}
          </div>
          <div>
            <span style={{ color: C.amber, fontFamily: FONT }}>{'>'}</span>{' '}
            连续 {report.streak} 天投喂{report.streak >= 7 ? ' · 真情陪伴' : ''}
          </div>
        </div>
      </Box>

      {/* next milestone */}
      <div style={{ fontSize: 16, marginTop: 8, color: C.green }}>
        <span style={{ color: C.amber }}>{'>'}</span>{' '}
        next milestone <span style={{ color: C.greenFaint }}>·</span>{' '}
        <span style={{ color: C.greenBright }}>{report.nextRankTokensAway != null ? formatCompact(report.nextRankTokensAway) : '—'} tokens</span> away from{' '}
        <span style={{ color: C.greenBright }}>{nextEnLower}</span>
      </div>

      {/* spacer */}
      <div style={{ flex: 1 }} />

      {/* footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.greenDim }}>
        <div>
          <span style={{ color: C.greenBright }}>●</span> <span style={{ fontFamily: FONT }}>nom</span>
          <span style={{ color: C.greenFaint }}> · </span>
          <span style={{ fontFamily: FONT_CN }}>一只吃 token 的桌面宠物</span>
        </div>
        <div>~/{slug}</div>
      </div>
    </div>
  );
}
