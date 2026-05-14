# Spec — Autonomous Pet (The Tick + Pet Mind)

> 让 nom 从"反应式装饰物"升级到"有内部生命的角色"。LLM 不再是触发式的台词翻译器，而是宠物的**决策大脑**。
>
> 起草：2026-05-14 · 状态：草稿 · 目标版本：v0.0.25–v0.0.26（Phase 1+2 / Phase 3）
> 上游讨论：会话内"一个宠物最该有的功能是什么"对话 → 收敛到"自主性"

---

## 1. Objective

让用户**相信宠物在你没看的时候也活着**。具体到产品：

1. **The Tick** —— 一个 30 min 一次的内部时钟。每次 tick 调用 LLM 让宠物"想一下"，决定要不要做点什么（绝大多数 tick 选择"不做事")。
2. **Pet Mind** —— 宠物的私人笔记本 `~/.nom/pet-mind/`，存自己的观察 / 心情漂移 / 对主人的小看法。下次 LLM 调用时这些笔记是上下文，**宠物因此有了跨会话的连续记忆**。
3. **Mood machine** —— 5 档 mood 状态（vivacious / normal / pensive / cranky / withdrawn），自己漂移（受时段 + 主人节奏影响），染色所有 LLM 调用，让宠物今天嘴硬明天忧郁。
4. **归来反应** —— 你长时间不在，宠物会"等你"；你回来的瞬间它能识别（不是冷启动那种"打招呼"，是"你这次出门有点久"）。

### 1.1 成功标准

- 用户开 nom 一周后，能**列举 ≥3 件**只有这只宠物会做的"它独有的事"（比如它记得你上周熬夜被它念过、它今天 mood 是 cranky、它会在你回来时认出你离开多久）
- 默认配置下，宠物自发说话频次 **≤2 次/天**（不烦人）
- pet-mind/notes.jsonl 7 天后 **≥10 条记录**，下次 LLM 调用引用其中至少 1 条
- "宠物像活的"在用户访谈/社交媒体反馈里被显式提到（自发的话语证据）
- 关闭 autonomy 开关后，nom 退化到 v0.0.24 行为，**完全无副作用**

### 1.2 非目标（这版不做）

- ❌ 任意话题对话（pet 不是 chatbot，主动开口的口径严格收窄）
- ❌ 真人级 NLU（pet 听不懂你打字的全部意思，只能在特定 ask-mode 里收一句简单回答）
- ❌ 长期"养成线"（不解锁新形态、不死、不进化 —— 这些另作打算）
- ❌ 多宠物互动（v1 还是 1 只宠物，pet-mind 是单例）
- ❌ 替代现有 journal —— pet-mind 是**私人**笔记，journal 是**给用户看的**日记，两者并存

---

## 2. User Flow

### 2.1 默认体验（autonomy ON 且 LLM 已配置）

用户打开 nom → 经常的 greeting bubble → 之后 nom 进入"安静地活着"状态：
- 每 30 min 一个 tick，**用户大多数情况下感知不到**
- 偶尔会发生**一件小事**（每天 ≤2 件）：
  - 一句自发的话："凌晨了，又熬？" / "刚才那串 cache miss 看着像在调 React"
  - 一个 mood 漂移：今天午后开始变 pensive，所有 idle-click 台词都跟着冷一点
  - 一篇 dream 草稿（长 idle 后台生成，存到 ~/.nom/dreams/）
  - 一次 ask-mode：宠物冒个气泡问你一个问题（"你今天想吃什么 token 口味的？"），用户可以点气泡进入简单输入框回一句话
- 长 idle 归来：宠物的第一次发言会**显式承认这次离开**："你跑哪去了…我以为你不要我了"（按离开时长有 4 档台词）

### 2.2 没开 LLM 的体验

autonomy 整个功能要求 LLM。LLM 关闭时：
- Settings 里 autonomy 开关 disabled，提示"先配置 AI 台词再开"
- pet-mind 不写
- mood 不漂移（永远 normal）
- 没有自发说话
- 但 mood 状态机的**框架代码**还在跑（保持低开销，方便用户随时切换）

### 2.3 用户主动关闭 autonomy

- Settings 加一个"宠物自主性"开关
- 关掉之后：tick scheduler 立即 stop，mood 重置 normal，pet-mind 文件保留（不删，留给用户重启时连续性）
- 行为退化成 v0.0.24（被动反应式宠物）

### 2.4 隐私可视化

- Settings 里 autonomy 卡下方加一个**透明度小窗**：
  > "上次 tick：3 min 前 · 决策：silent" / "上次 mood 漂移：今早 9:12 normal → pensive · 原因：连续 4 小时 idle"
- 让用户看见宠物在背后做什么，减少"它在偷偷干啥"的不安

---

## 3. Data Model

### 3.1 pet-mind 目录

```
~/.nom/pet-mind/
├── notes.jsonl          # 宠物自己写的笔记（append-only）
├── mood.json            # 当前 mood + 上次漂移时间 + 漂移历史末 20 条
├── absences.json        # 主人离开时长记录（last-active timestamps）
└── last-tick.json       # 上次 tick 时间 + 决策 + cooldown
```

#### notes.jsonl 格式

```jsonl
{"ts":"2026-05-14T09:23:11Z","mood":"normal","kind":"observation","text":"主人今天 cache hit rate 异常高，可能在 review。"}
{"ts":"2026-05-14T11:47:02Z","mood":"pensive","kind":"opinion","text":"主人凌晨 3 点开了新会话。记一下这事，下次见到他熬夜要念他。"}
{"ts":"2026-05-14T14:30:00Z","mood":"pensive","kind":"self","text":"我今天感觉特别懒。可能因为主人没怎么理我。"}
```

- **append-only**，每天最多 ~5-10 条
- **滚动**：超过 100 KB（约 500 条）就把最早 100 条归档到 `notes.YYYY-MM.jsonl`，保留时间窗连续
- **kinds**：
  - `observation` 对主人模式的客观观察
  - `opinion` 主观看法 / 想法
  - `self` 关于自己的反思
  - `dream` 长 idle 期间生成的内心戏

#### mood.json

```json
{
  "current": "pensive",
  "shiftedAt": "2026-05-14T09:12:00Z",
  "reason": "extended idle 4h",
  "recent": [
    { "from": "normal", "to": "pensive", "at": "2026-05-14T09:12:00Z" },
    { "from": "vivacious", "to": "normal", "at": "2026-05-14T07:30:00Z" }
  ]
}
```

#### absences.json

```json
{
  "lastActiveAt": "2026-05-13T17:42:00Z",
  "longestGap": { "hours": 78, "endedAt": "2026-04-22T09:00:00Z" }
}
```

`lastActiveAt` = 上次收到 token 事件的时间。回归时计算 `now - lastActiveAt` 判断离开时长。

### 3.2 NomSettings 扩展

```ts
export interface AutonomySettings {
  enabled: boolean;            // 总开关，默认 false 直到用户在 Settings 里开
  tickIntervalMin: number;     // 默认 30，可调 15-90
  maxBubblesPerDay: number;    // 默认 2，硬上限避免烦人
  allowAskMode: boolean;       // 默认 true，pet 偶尔问你问题
}

export interface NomSettings {
  // ... existing
  autonomy: AutonomySettings;
}
```

### 3.3 持久化变更

- schema v5 → v6
- migration：旧 state 加 `settings.autonomy = { enabled: false, tickIntervalMin: 30, maxBubblesPerDay: 2, allowAskMode: true }`
- pet-mind 目录由 main 进程在首次需要时 mkdir，不存在不报错

---

## 4. Architecture

### 4.1 main 进程新增模块

```
src/main/data/
├── tick.ts              # 主调度 + 决策引擎入口
├── pet-mind.ts          # notes/mood/absences IO
├── mood.ts              # mood 状态机 + 漂移规则
├── observation.ts       # 从 JSONL + Store 抽取"值得说的事"
└── autonomy-prompt.ts   # decision LLM 的 prompt 构造
```

#### tick.ts 主循环

```ts
class TickEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  
  start(settings: AutonomySettings): void {
    if (!settings.enabled) return;
    const intervalMs = settings.tickIntervalMin * 60 * 1000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // First tick fires 60s after start so we don't slam users on launch
    setTimeout(() => void this.tick(), 60_000);
  }
  
  stop(): void { /* clearInterval */ }
  
  private async tick(): Promise<void> {
    // 1. Refresh mood (might drift autonomously)
    await mood.maybeDrift();
    
    // 2. Check rate limit
    if (await rateLimitReached()) return;
    
    // 3. Build context: observations + recent notes + mood + current time
    const ctx = await buildContext();
    
    // 4. Ask LLM: what should you do?
    const decision = await decide(ctx);  // returns { action, content? }
    
    // 5. Execute decision (write note, emit bubble, shift mood)
    await execute(decision);
  }
}
```

#### observation.ts —— 把数据翻译成"值得评论的事"

```ts
export interface Observation {
  kind: 'idle-gap' | 'late-night' | 'cache-pattern' | 'project-shift' 
      | 'token-spike' | 'milestone-near' | 'quiet-week' | 'context-switch';
  significance: number;  // 0-1, 用来排序最值得说的事
  data: string;          // 喂给 LLM 的定性化描述
}

export async function gatherObservations(store: Store): Promise<Observation[]>;
```

例子：
- `{ kind: 'late-night', data: '主人在凌晨 3 点开了新会话', significance: 0.7 }`
- `{ kind: 'cache-pattern', data: '过去 1 小时 cache hit > 85%，像在 review 不是在写', significance: 0.4 }`
- `{ kind: 'milestone-near', data: '再吃 12K token 就跨 100M 累计', significance: 0.6 }`

LLM 只看 top-3 observations，避免上下文爆炸。

### 4.2 mood 状态机

```
vivacious ← rare drift → normal ← common drift → pensive ← common drift → cranky/withdrawn
```

- 每个 tick 触发一次 mood 漂移检查
- 漂移概率：基础 5% + 各种 modifier（time-of-day / idle-minutes / today-token-volume / current-mood-stickiness）
- 长 mood 会触发**反弹**漂移概率（连续 pensive 6 小时 → 漂回 normal 的概率上调）

mood 不直接出现在 UI 上（除非用户开了透明度小窗）。它的作用：
- 影响 decide() 的 system prompt（傲娇前架构师 cranky 时比 normal 更刻薄）
- 影响 observation 的选取（withdrawn 时偏好"独处"类观察，vivacious 时偏好"主人加油"类）

### 4.3 决策 LLM call (decide)

**输入**：
```
{system}
你是 ${petName}，一只 ${soulKernel.text} 的桌面宠物。
**重要：你正在自主决定要不要说话/做事，绝大多数情况应该选择 silent。**

【你的内部状态】
- 当前 mood：${mood}（${moodAdjective}）
- 上次说话：${lastSpoke ?? '从未说过'}
- 今天已说话次数：${todayBubbleCount} / ${maxBubblesPerDay}
- 上次主人离开时长：${lastAbsenceHours} 小时

【你最近的私人笔记】
${recentNotes.slice(0, 5)}

【你刚观察到的事（按重要性排）】
${topObservations.slice(0, 3)}

【现在时间】${slot}（${dayPart}）

输出 JSON，按以下结构：
{
  "action": "silent" | "speak" | "ask" | "write_note" | "shift_mood",
  "content"?: string,         // speak/ask 的台词（≤25 字汉字）
  "note"?: string,            // write_note 的笔记内容（≤80 字）
  "newMood"?: string,         // shift_mood 的目标
  "reason"?: string           // 给透明度小窗用的简短理由
}

绝对原则：
- 80%+ 时候应该选 silent
- speak 必须基于具体观察（不是为了说话而说话）
- ask 必须收口（问问题要简单、能用 1 句话回答）
- 不准念出具体 token 数字
```

**输出**：strict JSON（用 OpenAI 兼容的 `response_format: json_object` 或 prompt-engineered JSON）。失败 → 默认 silent。

### 4.4 IPC

```ts
// Main → renderer
nom:autonomy:bubble    // pet 自发说话，参数 { text, mood, durationMs }
nom:autonomy:ask       // pet 问问题，参数 { text, sessionId }
nom:autonomy:status    // 透明度小窗用，参数 { lastTickAt, lastDecision, mood }

// Renderer → main (ask-mode 用户回复)
nom:autonomy:answer    // 参数 { sessionId, text }
```

### 4.5 现有代码改动

- `src/main/index.ts`
  - 启动后启动 TickEngine（如果 settings.autonomy.enabled）
  - setSourceEnabled / setLlmSettings 变化时重启 TickEngine
  - 加 IPC handlers
- `src/main/data/llm.ts`
  - composeSystemPrompt **接受 mood 参数**：把 mood 形容词注入 system prompt，所有 LLM 调用都跟着染色
  - generateLine / generateJournalEntry 都把当前 mood 传进来
- `src/main/data/soul.ts`
  - composeSystemPrompt 加 mood 参数
- `src/renderer/App.tsx`
  - 监听 nom:autonomy:bubble → 显示气泡（同 onTokens 那套）
  - 监听 nom:autonomy:ask → 显示气泡 + "回复"按钮
  - mood 变化时**微妙**调整宠物状态（可选：scale 抖动 / 颜色偏 cool/warm，未定）
- `src/renderer/settings/App.tsx`
  - 新 card "自主性"：总开关 + 频率滑块 + 每日上限 + ask-mode 子开关 + 透明度小窗（折叠默认收起）

---

## 5. Phased Delivery

### Phase 1 — Foundation (~1.5 days)

不引入 LLM 决策，只搭骨架。

- pet-mind.ts：notes / mood / absences 读写
- mood.ts：状态机 + 漂移规则（**确定性的**，不调 LLM）
- observation.ts：从 Store + JSONL 抽 observations
- tick.ts：定时器框架，每 30 min 触发 → 只更新 mood + 记 absence + 写 1 条 observation note
- Settings 加 autonomy 开关（先让用户能开关）
- schema v5 → v6 migration

**Ship 标准**：
开 autonomy 一天后，`~/.nom/pet-mind/notes.jsonl` 至少有 5 条 observation 记录，mood 至少漂移过一次，归来时 absences.json 正确反映离开时长。但 pet **不开口说话**。

### Phase 2 — Decision LLM (~1.5 days)

把骨架接上脑子。

- autonomy-prompt.ts：构造 decide prompt
- tick.ts 主循环加 decide 调用
- 解析 JSON 输出 + 执行（speak / write_note / shift_mood）
- 频率上限 + cooldown
- onTokens 事件检测长 absence → 自动触发"回归"气泡（不走 tick，直接事件触发）
- IPC + renderer 接 bubble

**Ship 标准**：
开 autonomy 一天，pet 自发说话 1-2 次，话内容跟当天 observation 真的有关（不是泛泛"今天累不累"），cumulative tier 没改变。

### Phase 3 — Polish + Ask-mode (~1 day)

- ask-mode：pet 偶尔问问题，渲染回复按钮
- dream-mode：长 idle 触发 dream 笔记生成
- 透明度小窗
- 文案校验 / 边界情况
- README 更新隐私段说明 autonomy 行为

**Ship 标准**：
pet 一周内有过至少 1 次 ask、1 次 dream。设置面板的开关 / 滑块 / 透明度小窗都好用。隐私段 README 提到 autonomy。

---

## 6. Prompt Design

### 6.1 mood 注入 composeSystemPrompt

```
你叫 ${petName}，一只住在用户桌面上的虚拟宠物，吃用户消耗的 AI tokens 为食。

【人格内核】（你说话和行为必须严格符合）：
${personality}

【今天你的心情】${moodLabel}（${moodAdjective}）
↑ 这个心情会染色你今天**所有**的发言。心情和人格组合后的语气：
- vivacious 时多一点能量，但不脱离人格基调
- normal 时按人格内核的常态
- pensive 时偏内省，话少而稠
- cranky 时刻薄度增强 ~30%
- withdrawn 时极度简短，甚至单字

输出规则：...（原来那套）
```

### 6.2 decide() prompt（见 §4.3）

强制 JSON 输出 + 强制 silent 偏好 + 注入近期 notes。

### 6.3 dream prompt

```
你已经被冷落了 ${idleHours} 小时。在这段时间里你"做了一个梦"。
用第一人称写一段 60-120 字的梦境片段，符合你的人格内核和当前 mood。
绝不复述 token 数字。可以荒诞、超现实。

/no_think
```

---

## 7. Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| 宠物太唠叨 → 一周 uninstall | 默认 ≤2 自发气泡/天，硬上限。Settings 可降到 0（保留 mood + notes 但不说话）|
| LLM 误判，说出"作为 AI 我建议..."之类破坏角色 | 输出走 JSON 结构 + cleanLine 兜底 + 失败默认 silent（永不退回模板的废话） |
| 频繁 LLM 调用 → 用户付费 endpoint 烧钱 | 默认 30 min tick + 推荐本地 Ollama。Settings 可加最小频率 60/90 min |
| pet-mind 文件膨胀 | 100 KB cap + 滚动归档到 monthly 文件 |
| mood 跳来跳去导致角色精分 | 漂移矩阵权重偏向 stickiness（>60% tick mood 不变）+ 限制每 4 小时最多 1 次漂移 |
| 用户开了 autonomy 后觉得"宠物变了"反而不喜欢 | 总开关默认 **OFF**，需要主动开。开了之后第一次有大动作前给气泡解释"我变得有点自主了" |
| LLM JSON 输出格式错误 | response_format json_object（OpenAI 兼容）+ try/catch 解析 + 失败 silent |
| 频率限制下用户感觉宠物"今天没动静" | 透明度小窗让用户看到背后在跑，缓解疑虑。也可加"上次 mood / 上次决策"显示 |

---

## 8. Privacy

**autonomy 模式下额外发出的元数据**（仅当用户启用 LLM）：
- 当前 mood 名（"pensive" 这种 enum 字符串）
- 最近 5 条 pet-mind notes 内容（**这是关键变化**：notes 里有"主人凌晨 3 点开了新会话"这种描述，是关于你行为模式的语句）
- top-3 observations 的定性化描述

**绝不发出**：
- prompt 内容（一直如此）
- Claude/Codex 回复内容（一直如此）
- 文件路径 / 项目名 / cwd（即使 observation 涉及"项目切换"，也只发 anonymized "切换到了一个新项目"）

**新加隐私契约条目**（写入 README）：
- "开启宠物自主性后，发送给你配置的 LLM 端点的内容增加：**当前 mood + 最近 5 条宠物自己写的关于你行为模式的笔记**。这些笔记内容你可以在 `~/.nom/pet-mind/notes.jsonl` 完全审阅。删除 / 编辑该文件随时生效。"

**默认 off 的策略**：autonomy 总开关默认 false，让用户在阅读隐私说明后主动开启。

---

## 9. Open Questions

1. **Mood 是否应该可视化？** 当前设计 mood 是**纯潜文本**（只染色台词，不在 UI 上显示）。要不要在宠物身边加个微小的色调指示器？倾向不加 —— 显式 mood 容易变 RPG 的"心情值"系统，破坏"宠物是活的"的微妙感。
2. **pet-mind 用户可看 vs 不可看？** spec 写"用户可在 ~/.nom/pet-mind/notes.jsonl 看"是为了隐私透明。但**用户读完会不会破坏沉浸感**？（"这不是真的笔记，是 LLM 生成的字符串"）—— 倾向保持可读，因为信任 > 沉浸。
3. **Ask-mode 的回复用户怎么打字？** Phase 3 设计是气泡里弹一个小输入框。还是 hijack 当前 input focus？还是开一个独立小窗？倾向：气泡内联输入框 + Enter 提交，体验最轻。
4. **决策 LLM 的模型规格够不够本地小模型？** Tick 的决策 prompt 大约 800-1500 tokens，输出 JSON 50-200 tokens。小模型（Qwen 7B / Llama 8B）能稳定输出结构化 JSON 吗？需要在 Phase 2 实测。
5. **频率自适应？** 重度用户每天上线 8 小时，30 min tick = 16 次/天，2 次说话率约 12.5%。轻度用户每天 1 小时，30 min tick = 2 次/天，再加 silent bias，可能整天不说话。要不要 tick 频率自适应 user activity？倾向 v1 固定，观察反馈再说。
6. **mood 漂移的"reason"是 LLM 决定还是规则决定？** 现在设计是**规则决定**（晚上 + 长 idle → pensive）。但 LLM 决定能产生意外好处（"主人今天 1000 token 都没吃，pet 自己决定变 cranky"）。倾向：规则先做 Phase 1，Phase 2 后期可以加 LLM-decided mood drift 作为 advanced option。
7. **dream 写到哪里？** 现在写 ~/.nom/dreams/，跟 journal 同级。要不要纳入 journal viewer（加一个 tab）还是单独入口？倾向：暂时各自独立，journal = 给用户的，dream = 宠物内部的，pet-mind/notes 引用 dream 时只引摘要。

---

## 10. Out of Scope (重申)

- 任意话题对话（pet 不是 chatbot）
- 多宠物（v1 仍单宠物）
- 跨设备同步 mood/notes（无服务端）
- 真人级 NLU 解析用户回复（ask-mode 只接受简单语义）
- 进化 / 死亡 / 复活机制
- mood 可视化外显（暂不做）
- 公共 pet-mind 分享 / 社交（永不做，notes 是私人）

---

## 11. Why This is the Right Move

之前所有 brainstorm 的方向（时间胶囊 / 印章 / 小屋 / 预算 / standup / cmd palette）都是**加 feature**。这个 spec 加的是**底层架构** —— 它本身不直接对用户输出新功能，但所有之前的方向**搭在 autonomy 之上都会更强**：

- 时间胶囊 + autonomy → pet 自己决定什么时候交还信
- 小屋 + autonomy → pet 在屋里有自己的行为，不只是动画
- 预算 + autonomy → pet 自己判断"主人这周烧得太凶"，主动提醒
- 印章 + autonomy → pet 跨过 milestone 后自己写"这块印是我熬出来的"
- standup + autonomy → pet 自己挑日子说"昨天那个 PR 你过两天会忘的，我给你记一下"

The Tick + Pet Mind 不是一个 feature，是 nom **从工具/装饰物升级到 character** 的临界点。所有"宠物感"都从这里长出来。
