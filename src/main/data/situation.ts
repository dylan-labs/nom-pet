import type { Mood, PetMindNote, SoulKernel } from '../../shared/types';
import { Store } from './store';
import { localIsoString, readAbsence, readMood, readRecentNotes, readTodayBubbleCount } from './pet-mind';
import { computeLevel } from './levels';

/**
 * Raw situational snapshot for the decision LLM. The previous design
 * (observation.ts) hand-coded ~8 categories with thresholds and
 * pre-phrased Chinese strings; the LLM then picked from that menu.
 * That had two problems:
 *
 *   1. The pet sounded repetitive — every "user gone" tick produced
 *      "主人 X 小时没来喂我了" verbatim, because the LLM only saw that
 *      pre-built string.
 *   2. Rule bugs got laundered through the LLM. The original
 *      late-night observation fired on wall-clock alone (no recency
 *      check), claimed "主人居然还在写", and the LLM cited that fake
 *      claim in subsequent notes. Lies self-propagated for days.
 *
 * The fix is to give the LLM the actual raw situation and let it
 * decide what's noteworthy. We keep only one piece of pre-processing
 * here — qualitative buckets for token counts — because the spec
 * explicitly forbids reciting raw numbers and we want the language
 * model to have a phrase it can use.
 */

export interface SituationSnapshot {
  // When
  nowIso: string;
  localHour: number;        // 0–23
  weekday: string;          // 周一 / ...
  timeSlot: string;         // 凌晨 / 清晨 / 上午 / ...

  // Who
  petName: string;
  soulKernel: SoulKernel | null;
  mood: Mood;

  // Rank
  levelBadge: string;       // "大师 III" etc.
  tokensToNextLevel: number | null;

  // Intake — raw + qualitative side-by-side. The system prompt tells
  // the LLM to speak in the qualitative version; the raw value is here
  // so the model can reason about magnitude when deciding what's
  // noteworthy.
  cumulative: number;
  today: number;
  yesterday: number;
  weekAvg: number;
  cumulativeQual: string;
  todayQual: string;
  yesterdayQual: string;
  weekAvgQual: string;

  // Engagement timeline
  hoursSinceActive: number;          // +Infinity if never fed
  hoursSinceSpoke: number | null;    // null if never spoke
  todayBubbleCount: number;
  maxBubblesPerDay: number;

  // Pet's own recent self-notes — LLM context for continuity
  recentNotes: PetMindNote[];

  // Next round-number cumulative milestone within reach
  nextMilestone: {
    value: number;
    label: string;            // "1B" / "100M" / ...
    weeksAwayAtCurrentPace: number | null;
  } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function timeSlot(h: number): string {
  if (h < 5)  return '凌晨';
  if (h < 9)  return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '傍晚';
  return '深夜';
}

/**
 * Qualitative bucket for a token count. The pet should use these
 * phrases when speaking instead of reciting raw numbers (per spec).
 * Thresholds are loose by design — they map "how it feels in your
 * stomach" rather than "how big the number is", so adjacent buckets
 * blur. The LLM is free to colour them further with its own vocab.
 */
function qualitative(n: number): string {
  if (n === 0)            return '一点都没';
  if (n < 500)            return '一小口';
  if (n < 5_000)          return '正经一顿';
  if (n < 50_000)         return '吃饱了';
  if (n < 500_000)        return '吃撑了';
  if (n < 5_000_000)      return '吃成猪了';
  return '撑到爆炸级';
}

// Round-number cumulative milestones the pet might remark on as it
// crosses them. Spacing is log-ish so most active users hit one every
// few weeks rather than never.
const CUMULATIVE_MILESTONES = [
  1_000, 10_000, 100_000, 500_000,
  1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000,
  500_000_000, 1_000_000_000, 10_000_000_000, 100_000_000_000,
];

function fmtMilestone(n: number): string {
  if (n >= 1e9)  return `${(n / 1e9).toFixed(0)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

// ── Main ───────────────────────────────────────────────────────────────

export async function gatherSituation(store: Store): Promise<SituationSnapshot> {
  const now = Date.now();
  const date = new Date(now);
  const settings = store.getSettings();
  const snap = store.snapshot();
  const weekly = store.computeWeeklyReport(date);
  const report = store.computeDailyReport();
  const [abs, moodState, recentNotes, bubble] = await Promise.all([
    readAbsence(),
    readMood(),
    readRecentNotes(5),
    readTodayBubbleCount(),
  ]);
  const level = computeLevel(snap.cumulative);

  const hoursSinceActive = abs.lastActiveAt
    ? (now - Date.parse(abs.lastActiveAt)) / 3_600_000
    : Number.POSITIVE_INFINITY;
  const hoursSinceSpoke = bubble.lastAt
    ? (now - Date.parse(bubble.lastAt)) / 3_600_000
    : null;

  const yesterday = report?.yesterdayTokens ?? 0;
  const weekAvg = report?.weekAvgTokens ?? 0;

  const nextValue = CUMULATIVE_MILESTONES.find((t) => t > snap.cumulative) ?? null;
  let nextMilestone: SituationSnapshot['nextMilestone'] = null;
  if (nextValue != null) {
    const weeksAway = weekly.thisWeekTokens > 0
      ? (nextValue - snap.cumulative) / weekly.thisWeekTokens
      : null;
    nextMilestone = {
      value: nextValue,
      label: fmtMilestone(nextValue),
      weeksAwayAtCurrentPace: weeksAway != null && Number.isFinite(weeksAway)
        ? Math.round(weeksAway * 10) / 10
        : null,
    };
  }

  return {
    nowIso: localIsoString(date),
    localHour: date.getHours(),
    weekday: WEEKDAY_CN[date.getDay()]!,
    timeSlot: timeSlot(date.getHours()),

    petName: settings.petName,
    soulKernel: settings.soulKernel,
    mood: moodState.current,

    levelBadge: level.badge,
    tokensToNextLevel: level.nextThreshold != null
      ? Math.max(0, level.nextThreshold - snap.cumulative)
      : null,

    cumulative: snap.cumulative,
    today: snap.today,
    yesterday,
    weekAvg,
    cumulativeQual: qualitative(snap.cumulative),
    todayQual: qualitative(snap.today),
    yesterdayQual: qualitative(yesterday),
    weekAvgQual: qualitative(weekAvg),

    hoursSinceActive,
    hoursSinceSpoke,
    todayBubbleCount: bubble.count,
    maxBubblesPerDay: settings.autonomy.maxBubblesPerDay,

    recentNotes,
    nextMilestone,
  };
}
