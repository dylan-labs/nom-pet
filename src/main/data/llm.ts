import type { DialogueContext, JournalDailyMetadata, LlmSettings, Mood, SoulKernel } from '../../shared/types';
import { composeSystemPrompt } from './soul';
import { buildDecisionMessages, parseDecision, type Decision, type DecisionContext } from './autonomy-prompt';

const REQUEST_TIMEOUT_MS = 20000;
// Journals are longer (80-200 char prose) and thinking models may need
// more headroom to land in that band; bump both the timeout and budget.
const JOURNAL_TIMEOUT_MS = 45000;
const JOURNAL_MAX_TOKENS = 1536;
const JOURNAL_MIN_CHARS = 60;   // below this we treat as "model gave up" and fall back
const JOURNAL_MAX_CHARS = 260;  // hard cap on rendered prose
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

// Consume optional U+FE0F variation selector + any whitespace after the
// emoji — many models emit "☀️\n\n" with the VS that isn't \s-matched,
// which would otherwise leave an orphan codepoint at the start of body.
const WEATHER_EMOJI_RE = /^([☀☁☔❄🌤🌧🌫🌪🌈⛈])[️\s]*/u;

/**
 * Clean a journal-mode response: strip thinking traces, peel off a
 * weather emoji if the model put one at the start, collapse whitespace,
 * and enforce the character ceiling. Returns null if the cleaned body is
 * too short to be a usable journal (model gave up / emitted noise).
 */
function cleanJournal(raw: string): { body: string; weather: string | null } | null {
  let s = raw;
  const thinkClose = s.lastIndexOf('</think>');
  if (thinkClose >= 0) s = s.slice(thinkClose + '</think>'.length);
  s = s.trim();
  // Models sometimes wrap the whole thing in a quote / corner brackets.
  s = s.replace(/^[「『""''`"']\s*/, '').replace(/\s*[」』""''`"']$/, '');
  // Normalise whitespace: collapse runs of whitespace inside a paragraph
  // to single spaces, but keep paragraph breaks as a single newline.
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

  // Pull off a leading weather emoji if present, so the writer can store
  // it in the frontmatter rather than have it floating in the body.
  let weather: string | null = null;
  const m = s.match(WEATHER_EMOJI_RE);
  if (m) {
    weather = m[1]!;
    s = s.slice(m[0].length).trimStart();
  }

  if (s.length < JOURNAL_MIN_CHARS) return null;
  if (s.length > JOURNAL_MAX_CHARS) s = s.slice(0, JOURNAL_MAX_CHARS - 1).trimEnd() + '…';
  return { body: s, weather };
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
  kernel: SoulKernel | null = null,
  mood?: Mood,
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
          { role: 'system', content: composeSystemPrompt(ctx.petName ?? 'nom', kernel, 'line', mood) },
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
  petName = 'nom',
  kernel: SoulKernel | null = null,
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
            { role: 'system', content: composeSystemPrompt(petName, kernel) },
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

/** Format a token count in the journal user prompt without leaking the
 * raw figure into the model's vocabulary. The model is told elsewhere
 * not to recite numbers, but we still pre-bucket so it gets the vibe.
 */
function describeJournalTokens(n: number): string {
  if (n === 0)        return '一整天颗粒无收';
  if (n < 500)        return '才一小口，几乎等于没吃';
  if (n < 5_000)      return '吃了正经一顿';
  if (n < 50_000)     return '吃得挺饱';
  if (n < 500_000)    return '吃撑了';
  return '吃成猪，撑到爆炸';
}

function describeJournalCompare(y: number, dayBefore: number): string {
  if (dayBefore === 0) return '前天没数据，没法比';
  const pct = (y - dayBefore) / dayBefore;
  if (pct > 0.5)  return '比前天多一大截';
  if (pct > 0.1)  return '比前天稍多';
  if (pct < -0.5) return '比前天少了大半';
  if (pct < -0.1) return '比前天少一些';
  return '和前天差不多';
}

function describeWeekAvg(y: number, avg: number): string {
  if (avg === 0) return '周均没有参考';
  const ratio = y / avg;
  if (ratio > 1.5) return '远超周均';
  if (ratio > 1.1) return '略高于周均';
  if (ratio < 0.5) return '远低于周均';
  if (ratio < 0.9) return '略低于周均';
  return '和周均差不多';
}

function describeMilestones(ms: number[]): string {
  if (ms.length === 0) return '没有跨过新的里程碑';
  const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` :
    n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
  return `跨过了 ${ms.map(fmt).join(' / ')} 这些里程碑`;
}

/**
 * Generate one day's journal body via the configured LLM. Returns
 * `null` on any failure (auth, timeout, empty content, too-short
 * result) — the caller falls back to `renderTemplateJournal`. The
 * weather emoji is optional; null means "let the caller pick from the
 * template palette".
 */
export async function generateJournalEntry(
  settings: LlmSettings,
  petName: string,
  kernel: SoulKernel | null,
  meta: JournalDailyMetadata,
  dateLabel: string,
  mood?: Mood,
): Promise<{ body: string; weather: string | null } | null> {
  if (!settings.enabled || !settings.endpoint || !settings.model) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOURNAL_TIMEOUT_MS);

  const userPrompt =
    `请写昨天（${dateLabel}）的日记。

数据（仅作为情绪和事件依据，**不要照搬数字**）：
- 总共吃了：${describeJournalTokens(meta.yesterdayTokens)}
- 跟前天比：${describeJournalCompare(meta.yesterdayTokens, meta.dayBeforeTokens)}
- 跟周均比：${describeWeekAvg(meta.yesterdayTokens, meta.weekAvgTokens)}
- 里程碑：${describeMilestones(meta.milestonesCrossed)}

请用 ${petName} 的口吻、严格符合人格内核，写一段 80-200 字的散文体日记。开头可以放一个最贴当天氛围的天气 emoji。

/no_think`;

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
          { role: 'system', content: composeSystemPrompt(petName, kernel, 'journal', mood) },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: JOURNAL_MAX_TOKENS,
        temperature: 0.95,
        ...NO_THINK_FLAGS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[nom][llm][journal] non-2xx:', res.status);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const raw = pickContent(data.choices?.[0]?.message);
    if (!raw) return null;
    return cleanJournal(raw);
  } catch (err) {
    console.warn('[nom][llm][journal] error:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Autonomous tick — decision call ─────────────────────────────────────
//
// Per-tick "should I do anything right now?" LLM call. Strict JSON
// output (server-side via response_format when supported, fallback
// parser is forgiving). Returns null on any failure — the tick layer
// reads null as "stay silent", which is the desired safe default.

// Thinking-class models eat a lot of headroom inside <think> blocks
// before they ever emit content. Underset budget → response comes back
// content=null / reasoning_content=null. 2048 is enough for the
// largest decision response (~200 chars JSON) plus a multi-paragraph
// reasoning trace.
const DECISION_MAX_TOKENS = 2048;
const DECISION_TIMEOUT_MS = 45_000;

export async function decideAutonomousAction(
  settings: LlmSettings,
  ctx: DecisionContext,
): Promise<Decision | null> {
  if (!settings.enabled || !settings.endpoint || !settings.model) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS);

  const { system, user } = buildDecisionMessages(ctx);

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
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: DECISION_MAX_TOKENS,
        // Lower temperature than dialogue — the decision is structural,
        // we want it predictable. The persona's spice still survives
        // because the system prompt is character-rich.
        temperature: 0.6,
        // Note: deliberately NOT setting response_format on the
        // decision call. Thinking-class endpoints (MiniMax M2, Qwen3
        // *-Thinking, etc.) tend to return content=null when json mode
        // is forced — the reasoning path expects to think first, then
        // speak, and a strict json_object schema collides with that.
        // The prompt already specifies the JSON schema in plain text +
        // our parser tolerates markdown fences and <think>-wrapped
        // output, so behaviour is the same on servers that DO support
        // response_format.
        ...NO_THINK_FLAGS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[nom][llm][decide] non-2xx:', res.status);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const raw = pickContent(data.choices?.[0]?.message);
    if (process.env['NOM_DEBUG_DECIDE']) {
      console.log('[nom][llm][decide][debug] raw:', JSON.stringify(raw)?.slice(0, 400));
    }
    if (!raw) return null;
    return parseDecision(raw);
  } catch (err) {
    console.warn('[nom][llm][decide] error:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
