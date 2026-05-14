import type { Weekday } from '../../shared/types';

export function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatPercent(p: number | null, opts: { showSign?: boolean; digits?: number } = {}): string {
  if (p == null || !Number.isFinite(p)) return '—';
  const digits = opts.digits ?? 1;
  const pct = (p * 100).toFixed(digits);
  if (opts.showSign && p > 0) return `+${pct}%`;
  return `${pct}%`;
}

const WEEKDAY_CN: Record<Weekday, string> = {
  Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日',
};

export function weekdayCn(w: Weekday): string {
  return WEEKDAY_CN[w];
}

/** "2026-05-11", "2026-05-17" → "2026.05.11-17" (collapses common prefix). */
export function weekRangeLabel(start: string, end: string): string {
  const [sy, sm, sd] = start.split('-');
  const [ey, em, ed] = end.split('-');
  if (sy === ey && sm === em) return `${sy}.${sm}.${sd}-${ed}`;
  if (sy === ey) return `${sy}.${sm}.${sd}-${em}.${ed}`;
  return `${sy}.${sm}.${sd}-${ey}.${em}.${ed}`;
}

/** Compact form: 12,345 → "12K", 1,234,567 → "1.2M". */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Returns ranks like "学徒 III" → "APPRENTICE-III" (best-effort transliteration). */
const TIER_EN: Record<string, string> = {
  '新手': 'NOVICE',
  '学徒': 'APPRENTICE',
  '行家': 'EXPERT',
  '大师': 'MASTER',
  '宗师': 'GRANDMASTER',
  '传说': 'LEGEND',
  '战神': 'WAR-GOD',
};

export function tierEn(tier: string): string {
  return TIER_EN[tier] ?? tier.toUpperCase();
}
