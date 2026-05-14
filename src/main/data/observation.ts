import { Store, todayKey } from './store';
import { readAbsence } from './pet-mind';
import { computeLevel } from './levels';

/**
 * What the pet "notices" about the user this tick. Phase 1 only feeds
 * one of these into a note (no LLM yet); Phase 2 will pass the top 3
 * into the decision prompt as flavour for the pet's opinions.
 *
 * Each kind maps to a different pattern in the user's local usage —
 * idle gaps, late-night sessions, milestone proximity, etc. — that the
 * pet might plausibly remark on. `significance` is a 0-1 score so
 * callers can pick the most-worth-mentioning ones; `data` is the
 * already-prose description the LLM can quote as-is.
 *
 * No raw token counts in `data` — they'd leak through the LLM and the
 * pet would parrot them. Use qualitative phrasing only.
 */

export interface Observation {
  kind: 'idle-gap' | 'late-night' | 'token-spike' | 'quiet-week'
      | 'milestone-near' | 'first-day' | 'session-rhythm' | 'mood-cause';
  significance: number;
  data: string;
}

function hourLabel(h: number): string {
  if (h < 5)  return '凌晨';
  if (h < 9)  return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '傍晚';
  return '深夜';
}

function describeTokens(n: number): string {
  if (n === 0)        return '一点都没';
  if (n < 500)        return '才一小口';
  if (n < 5_000)      return '正经一顿';
  if (n < 50_000)     return '吃饱了';
  if (n < 500_000)    return '吃撑了';
  return '吃成猪了';
}

// Round-number cumulative milestones — same set the journal uses.
// Spacing is log-ish so most active users hit one every few weeks.
const CUMULATIVE_MILESTONES = [
  1_000, 10_000, 100_000, 500_000,
  1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000,
  500_000_000, 1_000_000_000, 10_000_000_000,
];

/** The nearest unreached cumulative milestone within reach this week, or null. */
function nearestMilestone(cumulative: number, weekAvgTokens: number): number | null {
  const next = CUMULATIVE_MILESTONES.find((t) => t > cumulative);
  if (next == null) return null;
  // Only flag if the user could realistically reach it in ~1 week of their average pace.
  const reachable = weekAvgTokens > 0 && (next - cumulative) <= weekAvgTokens * 7;
  return reachable ? next : null;
}

/**
 * Build the full list of observations from the current Store + recent
 * absence record. Caller is expected to sort by significance and pick
 * the top N for whatever they're doing (note write / LLM context).
 */
export async function gatherObservations(store: Store): Promise<Observation[]> {
  const out: Observation[] = [];
  const now = Date.now();
  const snap = store.snapshot();
  const settings = store.getSettings();
  const weekly = store.computeWeeklyReport(new Date(now));

  // ── Idle gap (read from absences for cross-session continuity) ─────
  const abs = await readAbsence();
  if (abs.lastActiveAt) {
    const gapH = (now - Date.parse(abs.lastActiveAt)) / 3_600_000;
    if (gapH >= 6) {
      out.push({
        kind: 'idle-gap',
        significance: Math.min(1, gapH / 24),
        data: `主人 ${gapH.toFixed(1)} 小时没来喂我了`,
      });
    } else if (gapH >= 2) {
      out.push({
        kind: 'idle-gap',
        significance: 0.3,
        data: `主人停手 ${gapH.toFixed(1)} 小时了，可能在干别的`,
      });
    }
  }

  // ── Late-night activity ────────────────────────────────────────────
  const hour = new Date(now).getHours();
  if (hour < 6) {
    out.push({
      kind: 'late-night',
      significance: 0.7,
      data: `现在是凌晨 ${hour} 点，主人居然还在写`,
    });
  } else if (hour >= 23) {
    out.push({
      kind: 'late-night',
      significance: 0.5,
      data: `${hour} 点了主人还没睡`,
    });
  }

  // ── Token spike (today vs week avg) ────────────────────────────────
  if (weekly.thisWeekTokens > 0 && weekly.daily.length === 7) {
    const todayBucket = weekly.daily.find((d) => d.dateKey === todayKey());
    const today = todayBucket?.tokens ?? 0;
    const otherDays = weekly.daily.filter((d) => d.dateKey !== todayKey() && d.tokens > 0);
    if (otherDays.length >= 2) {
      const otherAvg = otherDays.reduce((s, d) => s + d.tokens, 0) / otherDays.length;
      if (today > otherAvg * 2 && today > 50_000) {
        out.push({
          kind: 'token-spike',
          significance: 0.6,
          data: `主人今天的 token 量是平时两倍以上，${describeTokens(today)}`,
        });
      } else if (today > 0 && today < otherAvg * 0.3) {
        out.push({
          kind: 'quiet-week',
          significance: 0.4,
          data: `主人今天比平时安静多了，${describeTokens(today)}`,
        });
      }
    }
  }

  // ── Milestone proximity ────────────────────────────────────────────
  const near = nearestMilestone(snap.cumulative, weekly.thisWeekTokens / 7);
  if (near != null) {
    const fmt = near >= 1e9 ? `${(near / 1e9).toFixed(0)}B`
              : near >= 1e6 ? `${(near / 1e6).toFixed(0)}M`
              : `${(near / 1e3).toFixed(0)}K`;
    out.push({
      kind: 'milestone-near',
      significance: 0.5,
      data: `离 ${fmt} 累计里程碑不远了`,
    });
  }

  // ── First-day flavour ──────────────────────────────────────────────
  if (!abs.lastActiveAt) {
    out.push({
      kind: 'first-day',
      significance: 0.8,
      data: '我跟主人是新认识的，还没什么相处记忆',
    });
  }

  // ── Session rhythm (peak day of the week so far) ───────────────────
  if (weekly.peakDay && weekly.thisWeekTokens > 0) {
    const ratio = weekly.peakDay.tokens / weekly.thisWeekTokens;
    if (ratio > 0.5) {
      out.push({
        kind: 'session-rhythm',
        significance: 0.3,
        data: `本周主人主要在 ${weekly.peakDay.weekday} 吃东西，其他天都在划水`,
      });
    }
  }

  // ── Soul-kernel flavour ────────────────────────────────────────────
  // Surface a soft signal so notes feel persona-aware even before the
  // LLM step. Used only when nothing else fired.
  if (out.length === 0 && settings.soulKernel) {
    out.push({
      kind: 'mood-cause',
      significance: 0.1,
      data: `${hourLabel(hour)}里没什么大事发生`,
    });
  }

  out.sort((a, b) => b.significance - a.significance);
  return out;
}
