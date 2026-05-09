import type { DialogueContext, LlmSettings } from '../../shared/types';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_TOKENS = 60;
const MAX_LINE_CHARS = 26;

const SYSTEM_PROMPT = `你是 nom，一只住在用户桌面上的虚拟宠物，吃用户消耗的 AI tokens 为食。

性格：活泼、贪吃、嘴碎。
说话规则（必须严格遵守）：
- **只说一句话，最多 15 个汉字**
- 第一人称（我饿了 / 我盯着你）
- 不要 emoji、引号、Markdown、动作描述
- 不要"作为 AI"，你是宠物
- 不要追问用户`;

function userPromptFor(ctx: DialogueContext): string {
  const time = ctx.hour;
  const slot =
    time < 5  ? '凌晨' :
    time < 9  ? '清晨' :
    time < 12 ? '上午' :
    time < 14 ? '中午' :
    time < 18 ? '下午' :
    time < 22 ? '傍晚' : '深夜';

  // Level affects tone: 新手期谦虚撒娇；越往上越嚣张/老资格。
  const levelHint = ctx.level
    ? ` 你的当前段位是 ${ctx.level.badge}，说话语气要符合身份（新手期可怜兮兮 / 学徒慢慢长大 / 行家有底气 / 大师以上开始装 / 战神就装死神）。`
    : '';

  switch (ctx.trigger) {
    case 'session-start':
      return `情境：用户刚打开了一个新的 Claude Code 会话，时间是${slot}。说一句迎接他的台词。${levelHint}`;
    case 'milestone':
      return `情境：用户今天累计已经让你吃了 ${ctx.amount} 个 token，这是个里程碑数字。说一句庆祝/吐槽的台词。${levelHint}`;
    case 'eating':
      return `情境：用户正在用 Claude，刚喂了你 ${ctx.delta} 个 token。说一句吃东西的小感想。${levelHint}`;
    case 'idle-click':
      return `情境：用户闲着戳了你一下（不是来喂你东西的，就是手贱）。时间${slot}。说一句撒娇/讨好/吐槽的话，**绝对不要提 token / 喂食 / 数字**，单纯回应被戳。${levelHint}`;
    case 'wake':
      return `情境：你刚睡着，用户回来叫醒了你。说一句迷糊的、刚醒的台词。${levelHint}`;
    case 'level-up': {
      const up = ctx.levelUp;
      if (!up) return '情境：你升级了，说一句开心/嚣张的话。';
      if (up.tierJumped) {
        return `情境：你刚刚从 ${up.from.tier} 段位跨入了 ${up.to.tier} 段位（具体到 ${up.to.badge}）！这是大跨越，**仪式感要强**：说一句吹牛/装逼/感慨的话。`;
      }
      return `情境：你刚升级，从 ${up.from.badge} 升到了 ${up.to.badge}。说一句小确幸/嘚瑟的台词。`;
    }
  }
}

/** Strip reasoning-model thinking traces and any wrapping noise. */
function cleanLine(raw: string): string {
  let s = raw;
  // Some models wrap thinking in <think>...</think>; some emit only the
  // closing tag. Either way, anything before the LAST </think> is debris.
  const thinkClose = s.lastIndexOf('</think>');
  if (thinkClose >= 0) s = s.slice(thinkClose + '</think>'.length);
  s = s.trim();
  // Strip a single layer of wrapping quotes the model sometimes adds.
  s = s.replace(/^[「『""''`"']\s*/, '').replace(/\s*[」』""''`"']$/, '');
  // Collapse to one line.
  s = s.split(/[\r\n]+/)[0]!.trim();
  // Hard cap so a runaway response can't blow the bubble layout.
  // Append … on truncation so the reader can see the line was cut.
  if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS - 1).trimEnd() + '…';
  return s;
}

export async function generateLine(
  settings: LlmSettings,
  ctx: DialogueContext,
): Promise<string | null> {
  if (!settings.enabled || !settings.endpoint || !settings.model) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPromptFor(ctx) },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.95,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[nom][llm] non-2xx:', res.status);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) return null;

    const cleaned = cleanLine(raw);
    return cleaned || null;
  } catch (err) {
    console.warn('[nom][llm] error:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
