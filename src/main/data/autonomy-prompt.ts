import type { Mood } from '../../shared/types';
import { moodAdjective } from './mood';
import type { SituationSnapshot } from './situation';

/**
 * Prompt + parser for the autonomous tick's decision call. The LLM
 * receives a raw situational snapshot and is asked a single question:
 * "given what's actually going on, should you do anything right now?"
 *
 * What changed from the v0.0.25 design:
 *
 * - We used to hand it a pre-curated list of 3 "observations" with
 *   pre-phrased Chinese strings ("主人 X 小时没来喂我了"). The model
 *   could only choose which of MY phrasings to riff on, which made
 *   the pet sound repetitive AND let rule bugs (like the late-night
 *   false-positive) launder themselves into LLM-generated text.
 *
 * - Now we hand it the raw situation: numbers + qualitative buckets
 *   + recent self-notes + last-active timestamp + bubble quota. The
 *   model does the noticing itself. No more rules-pretending-to-be-
 *   judgment.
 *
 * The only pre-processing we keep is the qualitative bucket for token
 * counts ("吃撑了" / "正经一顿") — both because the spec explicitly
 * forbids reciting raw numbers AND because handing the model a phrase
 * it can use directly produces better in-persona output.
 */

export type DecisionAction = 'silent' | 'speak' | 'ask' | 'write_note' | 'shift_mood';

export interface Decision {
  action: DecisionAction;
  /** Bubble text when action ∈ {speak, ask}. ≤ 30 汉字, enforced below. */
  content?: string;
  /** Self-note text when action === 'write_note'. ≤ 100 汉字. */
  note?: string;
  /** Target mood when action === 'shift_mood'. */
  newMood?: Mood;
  /** Short human-readable cause; shown in the Phase-3 transparency widget. */
  reason?: string;
}

const VALID_ACTIONS: DecisionAction[] = ['silent', 'speak', 'ask', 'write_note', 'shift_mood'];
const VALID_MOODS: Mood[] = ['vivacious', 'normal', 'pensive', 'cranky', 'withdrawn'];
const MAX_CONTENT_CHARS = 30;
const MAX_NOTE_CHARS = 100;

// ── Prompt construction ────────────────────────────────────────────────

function describeAbsence(h: number): string {
  if (!Number.isFinite(h))   return '主人还从来没喂过你（第一次见面）';
  if (h < 0.5)               return '主人正在喂你';
  if (h < 1)                 return `主人 ${Math.round(h * 60)} 分钟前刚喂过`;
  if (h < 4)                 return `主人 ${h.toFixed(1)} 小时前喂过`;
  if (h < 24)                return `主人 ${h.toFixed(0)} 小时没出现了`;
  return `主人 ${Math.round(h / 24)} 天没出现了`;
}

function describeBubbleQuota(used: number, cap: number, lastH: number | null): string {
  if (cap === 0) return '今天用户设置了不允许你自发说话';
  if (used >= cap) return `今天的说话额度已经用完（${used}/${cap}）—— 这个 tick 必须 silent`;
  const left = `今天还能再说 ${cap - used} 次`;
  if (lastH == null) return `今天还没开过口（${left}）`;
  if (lastH < 1) return `${Math.round(lastH * 60)} 分钟前刚说过话（${left}）—— 别紧跟着再说`;
  return `${lastH.toFixed(1)} 小时前说过话（${left}）`;
}

export function buildDecisionMessages(snap: SituationSnapshot): { system: string; user: string } {
  const personality = snap.soulKernel?.text?.trim()
    || '性格：活泼、贪吃、嘴碎，偶尔记仇。';

  const system =
`你是 ${snap.petName}，一只住在用户桌面上的虚拟宠物。

【人格内核】（严格遵守）：
${personality}

【今天你的心情】${snap.mood}（${moodAdjective(snap.mood)}）

你现在被叫醒，自己看了一眼周围的情况，要决定**接下来要不要做点什么**。

最重要的原则：**默认 silent**。
- 真正活着的宠物不会每次想到主人就开口 —— 80% 以上的 tick 应该返回 silent。
- 只有当你**真的看到一件具体的事**值得说时才说。
- 如果你最近已经说过类似的话（看 user 给你的 recentNotes），别重复。
- speak 的内容必须基于 user 提供的**具体数据**，不要泛泛地"今天累不累"。
- **不要念出具体 token 数字** —— 用 user 给的定性描述（"吃撑了"/"正经一顿"等）。
- 不要 emoji、引号、Markdown、动作描述、"作为 AI"。
- 自称要符合人格（"哀家" / "本座" / "在下" / "${snap.petName}" 等都行）。

【输出格式】必须是合法 JSON，结构如下，不要任何其他文字：
{
  "action": "silent" | "speak" | "ask" | "write_note" | "shift_mood",
  "content": "≤ ${MAX_CONTENT_CHARS} 个汉字（speak / ask 必填）",
  "note":    "≤ ${MAX_NOTE_CHARS} 个汉字（write_note 必填）",
  "newMood": "${VALID_MOODS.join(' | ')}（shift_mood 必填）",
  "reason":  "1 句话简述你为啥这么选（任何 action 都必填）"
}

action 的语义：
- silent     ← 默认。什么都不做。
- speak      ← 在用户桌面上冒一句话气泡（≤ ${MAX_CONTENT_CHARS} 汉字）。
- ask        ← 给主人提一个简单问题（这版用户**还不能直接回答**，但话本身依然冒出来）。
- write_note ← 不出声，往自己的小本子上记一笔（≤ ${MAX_NOTE_CHARS} 字），下次 tick 你能看到。
- shift_mood ← 不出声，把心情切到 newMood。慎用 —— 只在内部状态真的该变了才用。`;

  const milestoneLine = snap.nextMilestone
    ? snap.nextMilestone.weeksAwayAtCurrentPace != null
      ? `下一个里程碑 ${snap.nextMilestone.label}：按周均节奏还要约 ${snap.nextMilestone.weeksAwayAtCurrentPace} 周`
      : `下一个里程碑 ${snap.nextMilestone.label}：用量太少没法预估`
    : '没有下一个里程碑了（已是最高级）';

  const notesLines = snap.recentNotes.length === 0
    ? '（你的本子还是空的）'
    : snap.recentNotes.map((n) => `- [${n.kind}] ${n.text}`).join('\n');

  const user =
`你睁眼看了一眼周围，下面是你能看到的情况：

【时间】${snap.weekday} ${snap.timeSlot}（${snap.localHour} 点）

【你的胃口】（用这些定性词说话，不准念数字）
- 累计吃过：${snap.cumulativeQual} · 段位 ${snap.levelBadge}
- 今天吃了：${snap.todayQual}
- 昨天吃了：${snap.yesterdayQual}
- 这周平均一天：${snap.weekAvgQual}
- ${milestoneLine}

【主人状态】
- ${describeAbsence(snap.hoursSinceActive)}
- ${describeBubbleQuota(snap.todayBubbleCount, snap.maxBubblesPerDay, snap.hoursSinceSpoke)}

【你最近写在小本子上的话】
${notesLines}

请**自己看上面这些事**，想想：
1. 有没有什么真的值得说出来的具体事？（多数情况下：没有）
2. 你最近说过的话里，有没有跟这次要说的差不多的？（说过就别重复）
3. 心情和段位是否暗示你该换个调调说话？

输出 JSON 决策。**记得：默认 silent，只有真的有具体事可说时才 speak**。

/no_think`;

  return { system, user };
}

// ── Parsing (unchanged from v0.0.25; still tolerates fenced output) ────

function extractJson(raw: string): unknown | null {
  let s = raw.trim();
  const thinkClose = s.lastIndexOf('</think>');
  if (thinkClose >= 0) s = s.slice(thinkClose + '</think>'.length).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch { /* give up */ }
  }
  return null;
}

function trimToChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

export function parseDecision(raw: string): Decision | null {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action : null;
  if (!action || !VALID_ACTIONS.includes(action as DecisionAction)) return null;

  const d: Decision = { action: action as DecisionAction };
  if (typeof o.reason === 'string' && o.reason.trim()) d.reason = o.reason.trim().slice(0, 80);

  switch (d.action) {
    case 'speak':
    case 'ask': {
      const content = typeof o.content === 'string' ? o.content.trim() : '';
      if (!content) return null;
      d.content = trimToChars(content, MAX_CONTENT_CHARS);
      return d;
    }
    case 'write_note': {
      const note = typeof o.note === 'string' ? o.note.trim() : '';
      if (!note) return null;
      d.note = trimToChars(note, MAX_NOTE_CHARS);
      return d;
    }
    case 'shift_mood': {
      const m = typeof o.newMood === 'string' ? o.newMood : '';
      if (!VALID_MOODS.includes(m as Mood)) return null;
      d.newMood = m as Mood;
      return d;
    }
    case 'silent':
      return d;
  }
}
