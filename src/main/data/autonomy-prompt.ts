import type { Mood, PetMindNote, SoulKernel } from '../../shared/types';
import type { Observation } from './observation';
import { moodAdjective } from './mood';

/**
 * Prompt + parser for the autonomous tick's decision call. The LLM is
 * being asked one question: "given who you are and what just happened,
 * should you do anything right now? If so, what?" — and is strongly
 * biased toward "silent" so the pet feels alive without being noisy.
 *
 * The decision is returned as a strict JSON envelope; we use the
 * OpenAI-compatible `response_format: { type: 'json_object' }` hint
 * AND prompt-engineer the structure, so endpoints that don't honour
 * the response_format still tend to produce parseable output.
 */

export type DecisionAction = 'silent' | 'speak' | 'ask' | 'write_note' | 'shift_mood';

export interface Decision {
  action: DecisionAction;
  /** Bubble text when action ∈ {speak, ask}. ≤ 25 汉字, validated below. */
  content?: string;
  /** Self-note text when action === 'write_note'. ≤ 80 汉字. */
  note?: string;
  /** Target mood when action === 'shift_mood'. */
  newMood?: Mood;
  /** Short human-readable cause; shown in the Phase-3 transparency widget. */
  reason?: string;
}

export interface DecisionContext {
  petName: string;
  soulKernel: SoulKernel | null;
  mood: Mood;
  recentNotes: PetMindNote[];
  observations: Observation[];
  todayBubbleCount: number;
  maxBubblesPerDay: number;
  hoursSinceLastSpoke: number | null;
  hoursSinceLastActive: number;
  hour: number;          // 0–23
}

const VALID_ACTIONS: DecisionAction[] = ['silent', 'speak', 'ask', 'write_note', 'shift_mood'];
const VALID_MOODS: Mood[] = ['vivacious', 'normal', 'pensive', 'cranky', 'withdrawn'];
const MAX_CONTENT_CHARS = 30;
const MAX_NOTE_CHARS = 100;

function timeSlot(hour: number): string {
  if (hour < 5)  return '凌晨';
  if (hour < 9)  return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '傍晚';
  return '深夜';
}

function describeBubbleQuota(used: number, cap: number): string {
  if (cap === 0) return '今天禁言（用户设置：不允许自发说话）';
  if (used >= cap) return `今天说话额度已用尽（${used}/${cap}）`;
  if (used === 0) return `今天还没开口（额度 ${cap}）`;
  return `今天已经说过 ${used}/${cap} 次`;
}

function describeAbsence(h: number): string {
  if (h < 1)   return '主人刚刚还在喂我';
  if (h < 4)   return `主人 ${h.toFixed(1)} 小时没动静`;
  if (h < 12)  return `主人 ${h.toFixed(0)} 小时没出现`;
  if (h < 24)  return `主人 ${h.toFixed(0)} 小时没回来了`;
  return `主人 ${Math.round(h / 24)} 天没出现`;
}

/**
 * Build the system+user messages for the decision LLM call. The
 * system half encodes the persona + decision rules; the user half is
 * a "状态快照" that changes every tick.
 */
export function buildDecisionMessages(ctx: DecisionContext): { system: string; user: string } {
  const personality = ctx.soulKernel?.text?.trim()
    || '性格：活泼、贪吃、嘴碎，偶尔记仇。';

  const system =
`你是 ${ctx.petName}，一只住在用户桌面上的虚拟宠物。

【人格内核】（严格遵守）：
${personality}

【今天你的心情】${ctx.mood}（${moodAdjective(ctx.mood)}）

你现在被叫醒，要决定**接下来要不要做点什么**。绝大多数情况下你应该选择 "silent"。
- 真正活着的宠物**不会每次想到主人就开口** —— 80% 以上的 tick 应该返回 silent。
- 只在**真的有事**值得说的时候才说（比如刚刚观察到一件具体的事）。
- 如果说话，必须**基于下面 user 给出的具体观察**，不要泛泛地"今天累不累"。
- 不准在 content 里念出具体 token 数字。
- 不要 emoji、引号、Markdown、动作描述、"作为 AI"。
- 自称要符合人格（"哀家" / "本座" / "在下" / "${ctx.petName}" 等都行）。

【输出格式】必须是合法 JSON，结构如下，不要任何其他文字：
{
  "action": "silent" | "speak" | "ask" | "write_note" | "shift_mood",
  "content": "≤ ${MAX_CONTENT_CHARS} 个汉字（speak/ask 必填）",
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

  const obsLines = ctx.observations.slice(0, 3).map((o, i) => `${i + 1}. ${o.data}`).join('\n');
  const noteLines = ctx.recentNotes.slice(-5).map((n) => `- [${n.kind}] ${n.text}`).join('\n');

  const user =
`【时间】${timeSlot(ctx.hour)}（${ctx.hour} 点）
【主人状态】${describeAbsence(ctx.hoursSinceLastActive)}
【你今天说话情况】${describeBubbleQuota(ctx.todayBubbleCount, ctx.maxBubblesPerDay)}
${ctx.hoursSinceLastSpoke != null
  ? `【上次开口】${ctx.hoursSinceLastSpoke.toFixed(1)} 小时前`
  : '【上次开口】还没开过口'}

【你刚观察到的事（按重要性排）】
${obsLines || '（这一刻没什么特别值得说的）'}

【你最近写在小本子上的话】
${noteLines || '（你的本子还是空的）'}

请输出 JSON 决策。再次提醒：默认 silent，只在真的有具体事可说时才 speak。/no_think`;

  return { system, user };
}

// ── Parsing ────────────────────────────────────────────────────────────

/**
 * Tolerant JSON extractor. Tries straight parse, then a {...} regex
 * peel for endpoints that wrap output in markdown fences or natural-
 * language preambles ("好的，这是 JSON: {...}"). Returns null on any
 * structural problem — caller treats null as silent.
 */
function extractJson(raw: string): unknown | null {
  let s = raw.trim();
  // Some servers wrap response in <think> blocks — strip them.
  const thinkClose = s.lastIndexOf('</think>');
  if (thinkClose >= 0) s = s.slice(thinkClose + '</think>'.length).trim();
  // Strip markdown code fences if present.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }
  // Last resort: find the first { ... last } and try that.
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
  // Length here is JS char count — close enough to "汉字数" for our purposes
  // since we're not mixing alphabets much in pet dialogue.
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
