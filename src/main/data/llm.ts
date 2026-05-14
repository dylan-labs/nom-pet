import type { DialogueContext, LlmSettings } from '../../shared/types';

const REQUEST_TIMEOUT_MS = 20000;
// Thinking-model servers often ignore enable_thinking/reasoning_effort and
// still emit a <think> block. Budget enough room to finish reasoning AND
// produce a real reply; cleanLine strips the trace before display.
const MAX_TOKENS = 1024;
const MAX_LINE_CHARS_DEFAULT = 26;
const MAX_LINE_CHARS_REPORT = 60;

/**
 * Best-effort "disable reasoning" flags. OpenAI-compatible servers ignore
 * unknown fields, so we send all known dialects in one shot:
 *   - enable_thinking            → Qwen3 (DashScope, self-hosted vLLM)
 *   - reasoning_effort           → OpenAI o-series, Groq
 *   - chat_template_kwargs       → vLLM template-level switch (MiniMax-M2, Qwen3)
 *   - thinking.type='disabled'   → some Anthropic-compat proxies
 *   - thinking_config.budget=0   → Gemini-compat proxies
 * Plus a "/no_think" directive appended to the user message for models that
 * only respect prompt-level signals.
 */
const NO_THINK_FLAGS = {
  enable_thinking: false,
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
  thinking: { type: 'disabled' },
  thinking_config: { thinking_budget: 0 },
} as const;

function systemPromptFor(petName: string): string {
  return `你叫 ${petName}，一只住在用户桌面上的虚拟宠物，吃用户消耗的 AI tokens 为食。

性格：活泼、贪吃、嘴碎，偶尔记仇。
说话规则（必须严格遵守）：
- **直接输出最终答案，不要任何思考过程，不要 <think> 标签、不要"让我想想"之类的前言**
- **只说一句话，最多 15 个汉字**
- 第一人称（我饿了 / 我盯着你）
- 不要 emoji、引号、Markdown、动作描述
- 不要"作为 AI"，你是 ${petName}，是只小宠物
- 不要追问用户
- 用户如果问你叫什么，就说"我叫 ${petName}"，别说 nom 或别的名字`;
}

/** Qualitative size buckets so the model isn't staring at a naked number. */
function describeAmount(n: number): string {
  if (n === 0)        return '完全没东西吃，饿到怀疑人生';
  if (n < 500)        return '才一小口';
  if (n < 5_000)      return '正经吃了一顿';
  if (n < 50_000)     return '吃撑了';
  if (n < 500_000)    return '已经在暴饮暴食';
  return '吃成猪了，要爆炸';
}

function describeDelta(n: number): string {
  if (n < 100)        return '小口';
  if (n < 1_000)      return '一勺';
  if (n < 10_000)     return '一碗';
  if (n < 100_000)    return '一大盆';
  return '直接喂到吐';
}

/** Frame "minutes since last fed" as a vibe for the model. */
function describeFedGap(mins: number | null | undefined): string | null {
  if (mins == null) return null;          // never fed this session — let prompt omit
  if (mins < 2)     return '你刚刚才吃过';
  if (mins < 10)    return `${mins} 分钟前刚被喂过，还在回味`;
  if (mins < 60)    return `已经 ${mins} 分钟没吃东西了`;
  const h = Math.floor(mins / 60);
  return `${h} 小时没吃东西了，饿`;
}

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

  const todayBits = ctx.todayTokens != null
    ? `今天到现在你吃了 ${ctx.todayTokens} 个 token（${describeAmount(ctx.todayTokens)}）`
    : null;
  const fedBits = describeFedGap(ctx.minutesSinceLastFed);

  switch (ctx.trigger) {
    case 'session-start':
      return `情境：用户刚打开了一个新的 Claude Code 会话，时间是${slot}。${todayBits ?? ''}。说一句迎接他的台词。${levelHint}`;
    case 'milestone':
      return `情境：用户今天累计已经让你吃了 ${ctx.amount} 个 token（${describeAmount(ctx.amount ?? 0)}），这是个里程碑数字。说一句庆祝/吐槽的台词。${levelHint}`;
    case 'eating':
      return `情境：用户正在用 Claude，刚喂了你 ${ctx.delta} 个 token（这一口是${describeDelta(ctx.delta ?? 0)}）。${todayBits ? `${todayBits}。` : ''}说一句吃东西的小感想。${levelHint}`;
    case 'idle-click': {
      const extras = [todayBits, fedBits].filter(Boolean).join('；');
      const extraLine = extras ? `背景信息（**不要直接念出数字**，只用来决定语气）：${extras}。` : '';
      return `情境：用户闲着戳了你一下（不是来喂你东西的，就是手贱）。时间${slot}。${extraLine}说一句撒娇/讨好/吐槽的话，**绝对不要提具体 token 数字**，可以隐晦地暗示"今天吃饱了"或"很久没喂了"。${levelHint}`;
    }
    case 'wake':
      return `情境：你刚睡着，用户回来叫醒了你。${fedBits ? `${fedBits}。` : ''}说一句迷糊的、刚醒的台词。${levelHint}`;
    case 'level-up': {
      const up = ctx.levelUp;
      if (!up) return '情境：你升级了，说一句开心/嚣张的话。';
      if (up.tierJumped) {
        return `情境：你刚刚从 ${up.from.tier} 段位跨入了 ${up.to.tier} 段位（具体到 ${up.to.badge}）！这是大跨越，**仪式感要强**：说一句吹牛/装逼/感慨的话。`;
      }
      return `情境：你刚升级，从 ${up.from.badge} 升到了 ${up.to.badge}。说一句小确幸/嘚瑟的台词。`;
    }
    case 'daily-report': {
      const r = ctx.report;
      if (!r) return '情境：每日小结，说一句吐槽。';
      const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` :
        n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` :
        n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
      const vsYday = r.dayBeforeTokens > 0
        ? `比前天 ${fmt(r.dayBeforeTokens)} ${r.yesterdayTokens > r.dayBeforeTokens ? '多' : '少'} ${Math.round(Math.abs(r.yesterdayTokens - r.dayBeforeTokens) / r.dayBeforeTokens * 100)}%`
        : '前天没数据';
      const vsAvg = r.weekAvgTokens > 0
        ? `周均 ${fmt(r.weekAvgTokens)}`
        : '没有周均参考';
      return `情境：早安！要给用户做昨天的"每日小结"。数据：昨天他喂了你 ${fmt(r.yesterdayTokens)} token（${vsYday}，${vsAvg}）。说一句**有数据 + 有态度**的总结，可以吐槽 / 感慨 / 提醒，2 行内（最多 30 字），气泡里要装得下。${levelHint}`;
    }
  }
}

/**
 * Pick the best textual field from a chat-completion message. Thinking-model
 * servers may put the reply in `reasoning_content` and leave `content` null,
 * or vice versa — fall back across both.
 */
function pickContent(
  msg: { content?: string | null; reasoning_content?: string | null } | undefined,
): string | null {
  if (!msg) return null;
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content;
  return null;
}

/** Strip reasoning-model thinking traces and any wrapping noise. */
function cleanLine(raw: string, maxChars: number): string {
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
  if (s.length > maxChars) s = s.slice(0, maxChars - 1).trimEnd() + '…';
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
          { role: 'system', content: systemPromptFor(ctx.petName ?? 'nom') },
          { role: 'user', content: userPromptFor(ctx) + '\n/no_think' },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.95,
        ...NO_THINK_FLAGS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[nom][llm] non-2xx:', res.status);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const msg = data.choices?.[0]?.message;
    // Thinking-model servers may emit content=null and put text in
    // reasoning_content. cleanLine still strips </think> from whichever wins.
    const raw = pickContent(msg);
    if (!raw) return null;

    const maxChars = ctx.trigger === 'daily-report'
      ? MAX_LINE_CHARS_REPORT
      : MAX_LINE_CHARS_DEFAULT;
    const cleaned = cleanLine(raw, maxChars);
    return cleaned || null;
  } catch (err) {
    console.warn('[nom][llm] error:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like generateLine but surfaces structured failure details — used by the
 * settings "测试连接" button so users can tell apart network / auth / model
 * issues without digging in logs. Uses a bigger token budget than the live
 * call so thinking-style models (e.g. MiniMax-M2) have room to finish their
 * `<think>` block AND emit a real reply.
 */
export async function testLlm(
  settings: LlmSettings,
): Promise<{ ok: true; sample: string } | { ok: false; error: string }> {
  if (!settings.endpoint) return { ok: false, error: '缺少 Endpoint' };
  if (!settings.model)    return { ok: false, error: '缺少 Model' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await fetch(settings.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            { role: 'system', content: systemPromptFor('nom') },
            { role: 'user', content: userPromptFor({ trigger: 'idle-click', hour: new Date().getHours() }) + '\n/no_think' },
          ],
          max_tokens: MAX_TOKENS,
          temperature: 0.95,
          ...NO_THINK_FLAGS,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if ((err as Error).name === 'AbortError') {
        return { ok: false, error: `请求超时（${REQUEST_TIMEOUT_MS}ms）` };
      }
      return { ok: false, error: `网络错误：${msg}` };
    }

    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      return { ok: false, error: `HTTP ${res.status}${body ? ` — ${body}` : ''}` };
    }

    let data: {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    try {
      data = await res.json() as typeof data;
    } catch (err) {
      return { ok: false, error: `响应不是合法 JSON：${(err as Error).message}` };
    }

    const raw = pickContent(data.choices?.[0]?.message);
    if (!raw) {
      return { ok: false, error: '响应里 content 和 reasoning_content 都是空（max_tokens 可能不够）' };
    }

    const cleaned = cleanLine(raw, MAX_LINE_CHARS_DEFAULT);
    if (!cleaned) {
      return { ok: false, error: `内容清洗后为空。原始响应片段：${raw.slice(0, 80)}` };
    }
    return { ok: true, sample: cleaned };
  } finally {
    clearTimeout(timer);
  }
}
