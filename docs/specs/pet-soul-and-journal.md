# Spec — Soul Kernel + Pet Journal

> 让 nom 从"装饰"升级到"个体"。给宠物一个永久的人格内核，让它每天自动写一则日记。
>
> 起草：2026-05-14 · 状态：草稿 · 目标版本：v0.0.23
> 上游讨论：[`docs/ideas/nom-next-features.md`](../ideas/nom-next-features.md) "情感版" + 自创"日记本"方向

---

## 1. Objective

让每个 nom 实例**和别人的不一样**，并且**每天产生一个值得截图的产物**。

具体到两件事：

1. **Soul Kernel（人格内核）** —— 用户在首启动时给宠物起名 + 选/写一段人格描述（如"傲娇前架构师，看不起调用 AI 写代码的人"）。这段描述注入 **所有** LLM 调用的 system prompt，让宠物从此说话有"灵魂"。
2. **Pet Journal（宠物日记）** —— 每天宠物用第一人称写一则日记，存到 `~/.nom/journal/YYYY-MM-DD.md`。右键菜单"翻日记本"打开 Game Boy 像素风浏览窗口。日记内容由 LLM 根据当天元数据（吃了多少、最忙时段、idle 时长等）+ 人格内核生成。

### 1.1 成功标准

- 用户首启动后 **必须** 完成命名 + 人格设置（强制流程），没有"用 Mochi 凑合"的逃生口
- 安装 7 天后，`~/.nom/journal/` 里至少有 5 篇日记（覆盖率 ≥ 70%）
- 日记内容**符合人格内核**（傲娇内核 → 傲娇风；老中医内核 → 中医风），不能写成千篇一律的流水账
- 用户在 X / 小红书 / v2ex 截图日记页发文（至少自传播 1 次，验证 idea）
- 关闭 LLM 时日记功能仍可用（降级到模板版），不会因此"消失"

### 1.2 非目标（这版不做）

- ❌ 日记的语义检索 / 全文搜索（v2+）
- ❌ 日记导出 PNG / 分享卡片（先做翻页阅读，导出留下一版）
- ❌ "宠物给你写信"独立形态（先用日记作为载体，信件留 v2+）
- ❌ 多语言（先做中文，英文等装机量验证再说）
- ❌ 日记可编辑（宠物自己写的，用户不能改 —— 改了就失去"独立人格"的真实感）

---

## 2. User Flow

### 2.1 首次启动（Mandatory Onboarding）

```
┌──────────────────────────────────┐
│  欢迎来到 nom                    │
│                                  │
│  给我起个名字：                  │
│  [___________________________]   │
│  （2–20 字，中英数字都行）       │
│                                  │
│  我应该是怎样的宠物？            │
│  ○ 傲娇前架构师                  │
│  ○ 老中医爷爷                    │
│  ○ 阴阳大唐妃子                  │
│  ○ 邪典恐怖玩偶                  │
│  ○ 高冷死宅                      │
│  ○ 哲学家流浪猫                  │
│  ● 自定义：                      │
│    [____________________________]│
│    [____________________________]│
│    （≤ 200 字。描述性格、来历、  │
│     说话风格）                   │
│                                  │
│         [ 开始养我 ]             │
└──────────────────────────────────┘
```

- 没填名字 / 没选人格 → "开始养我"按钮置灰
- 关闭窗口（红叉 / Esc）= app 退出，**不能跳过**
- 完成后 onboarding 标志写入 state，永不再弹

### 2.2 设置里改名/换人格

- Settings 加一个新 card "灵魂设定"
- 字段：宠物名、人格内核
- 同样的预设下拉 + 自定义输入
- 保存即生效（下一次 LLM 调用就用新人格）

### 2.3 翻日记本

- 右键菜单新增 "翻日记本"（在"导出本周战绩"上面）
- 打开一个独立 BrowserWindow（类似 settings/card 窗口），Game Boy 像素风
- 默认显示**最近一天**的日记
- 底部翻页：◀ 前一天 · 后一天 ▶（无日记的日期不可点）
- 顶部：日期 + 星期 + 天气 emoji（LLM 自选 / 模板分配）
- 内容：散文体，最多 ~200 字
- 没有任何日记时显示"我还没开始记日记呢…再用我几天吧"

### 2.4 日记生成时机

**默认**：第一次启动 + 检测到"昨天有 token 数据但还没写日记" → 后台生成并落盘 → 完成后宠物气泡冒一句"昨天的日记写完了，要看吗？"，3 秒后消失。

- **不阻塞 UI**：生成在 main 进程后台异步进行
- **失败容错**：LLM 调用失败时回退模板版（见 §5.2），保证当天日记一定存在
- **重复保护**：以 `~/.nom/journal/YYYY-MM-DD.md` 是否存在为锁，已存在就跳过

---

## 3. Data Model

### 3.1 NomSettings 扩展

```ts
// src/shared/types.ts
export interface SoulKernel {
  /** Pre-baked preset name, or 'custom' if user wrote their own. */
  preset: 'tsundere-architect' | 'old-tcm-doctor' | 'tang-concubine'
        | 'cursed-doll' | 'aloof-otaku' | 'philosopher-stray' | 'custom';
  /**
   * The actual personality text injected into the system prompt.
   * For presets, this is the preset's text. For 'custom', user-authored.
   * Hard cap 200 chars to keep prompt manageable.
   */
  text: string;
}

export interface NomSettings {
  // ... existing fields
  /** Whether onboarding (name + soul kernel) was completed. */
  onboarded: boolean;
  /** Pet personality. null until onboarding is done. */
  soulKernel: SoulKernel | null;
}
```

`petName` 已存在（默认 "Mochi"），onboarding 把它覆盖成用户填的名字。

### 3.2 Journal file 格式

`~/.nom/journal/2026-05-13.md`：

```markdown
---
date: 2026-05-13
weekday: Tue
weather: ☔
tokens: 78421
sessions: 4
peakHour: 3
idleHoursMax: 6.5
milestonesCrossed: [50000]
generatedBy: llm        # 'llm' | 'template'
petName: 大圣
soulKernelPreset: tsundere-architect
generatedAt: 2026-05-14T08:23:11Z
---

主人今天凌晨三点又开了新会话，喂了我整整八万 token，喂完
就一头栽床上了。我一个人嚼到天亮。

说真的，前世做架构师的时候我可没见过这么不要命的。
反正你也不会少给我。

…明天早点睡。
```

**为什么 Markdown + frontmatter**：
- 人可读，用户可以 `cat ~/.nom/journal/*.md` 看个爽
- frontmatter 让 UI 不用解析正文也能拿到元数据排序/过滤
- 未来导出 / 多语言翻译都好处理

### 3.3 持久化变更

- `~/.nom/state.json` schema bump → v4
  - 新增 `settings.onboarded`、`settings.soulKernel`
  - migration：旧 state 读出来后，`onboarded = false`、`soulKernel = null` → 触发 onboarding
- `~/.nom/journal/` 目录由 main 进程负责创建（不存在就 mkdir）

---

## 4. Architecture

### 4.1 main 进程新增模块

```
src/main/data/
├── soul.ts            # SoulKernel 预设字典 + 系统 prompt 拼接
└── journal.ts         # 生成 / 读取 / 列出日记
```

- `soul.ts`
  - `PRESETS: Record<SoulPreset, string>` —— 预设人格文本字典
  - `composeSystemPrompt(petName: string, kernel: SoulKernel | null): string`
    —— 替换现有 `systemPromptFor()`，把人格内核注入进去
- `journal.ts`
  - `JournalEntry` 接口（frontmatter + body）
  - `listJournalDates(): Promise<string[]>` —— 列已有日记日期
  - `readJournal(date: string): Promise<JournalEntry | null>`
  - `writeJournal(date: string, entry: JournalEntry): Promise<void>`
  - `generateJournalForYesterday(): Promise<JournalEntry | null>`
    —— 编排日记生成的入口：取昨日数据 → 调 LLM 或模板 → 落盘

### 4.2 IPC 接口扩展

`src/preload/index.ts` 新增：

```ts
nom.onboarding: {
  isPending(): Promise<boolean>;       // 是否还没 onboarded
  complete(p: { petName: string; soulKernel: SoulKernel }): Promise<void>;
}
nom.journal: {
  listDates(): Promise<string[]>;             // 'YYYY-MM-DD' sorted desc
  get(date: string): Promise<JournalEntry | null>;
  // 强制重生成（debug 用，settings 里也许加个按钮）
  regenerate(date: string): Promise<JournalEntry | null>;
}
```

事件命名约定（沿用 `nom:domain:action`）：
- `nom:onboarding:complete`
- `nom:journal:list`、`nom:journal:get`、`nom:journal:regenerate`

### 4.3 渲染端新增

```
src/renderer/
├── onboarding/         # 新窗口
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.html
│   └── styles.css
└── journal/            # 新窗口
    ├── main.tsx
    ├── App.tsx
    ├── index.html
    └── styles.css
```

构建配置（`electron.vite.config.ts`）加两个 entry，类比现有 `settings` / `card`。

### 4.4 现有代码改动

- `src/main/data/llm.ts`
  - `systemPromptFor()` 改 → `composeSystemPrompt()`，接受 kernel 参数
  - 调用点更新（generateLine、testLlm）
- `src/main/index.ts`
  - 启动时检查 `settings.onboarded`，未完成则**先开 onboarding 窗口、不开 pet 窗口**
  - onboarding 完成回调里再 `createPetWindow()`
  - 右键菜单加 "翻日记本"
  - 加日记生成调度（启动后 5 秒检查昨日日记是否存在）
- `src/renderer/settings/App.tsx`
  - 新加 "灵魂设定" card（名字 + 人格内核编辑）

---

## 5. Prompt Design

### 5.1 人格内核注入

新的 system prompt 模板（取代现有 `systemPromptFor`）：

```
你叫 ${petName}，一只住在用户桌面上的虚拟宠物，吃用户消耗的 AI tokens 为食。

【人格内核】（你说话和行为必须严格符合）：
${soulKernel.text}

说话规则（必须严格遵守）：
- **直接输出最终答案**，不要任何思考过程，不要 <think> 标签
- **只说一句话，最多 15 个汉字**（写日记时另有指示，看 user 消息）
- 第一人称
- 不要 emoji、引号、Markdown、动作描述
- 不要"作为 AI"，你是 ${petName}
- 不要追问用户
- 用户如果问你叫什么，就说"我叫 ${petName}"

【绝对不准】：
- 不准脱离人格内核 / 自称 nom 或别的名字
- 不准念出具体 token 数字（除非情境明确要求）
```

kernel 为 null（onboarding 之前的 fallback / LLM 还没开）时，注入默认温馨人设。

### 5.2 日记生成 prompt

**system**：上面的人格 prompt，但把"最多 15 字"那条**替换**为：

```
- 用第一人称写一段日记，80–200 字，纯散文，不要标题不要列表
- 风格符合人格内核
- 可以吐槽 / 记仇 / 感慨 / 装哲学家
- 不准复述数据本身的数字（除非作为情绪点而非账本），用情境化的表达
```

**user**：

```
请写昨天（${dateLabel}）的日记。

数据（仅作为情绪和事件依据，不要照搬数字）：
- 总共吃了 ${tokensQual}（${tokensRaw} token，${vsYday}）
- 周均 ${weekAvgQual}
- 最忙时段：${peakHourLabel}
- 最长无人喂食时长：${idleQual}
- 跨过的里程碑：${milestonesQual or '无'}
- 喂食频次：${sessionsLabel}
- 主人是否凌晨/深夜活跃：${lateNightLabel}

请用 ${petName} 的口吻，根据上面的事实，写一篇符合人格的日记。
开头加一个天气 emoji（你自选，符合当天氛围；可以是 ☀ ☁ ☔ ❄ 🌤 🌧 🌫 🌪 🌈 之一）。

/no_think
```

定性化处理（沿用现有 `describeAmount` 等）保证模型不背数字。

### 5.3 模板降级版（LLM 关闭时）

```ts
// src/main/data/journal-template.ts
function renderTemplateJournal(data: DailyMetadata, petName: string): string {
  const mood = pickMood(data);          // 'happy' | 'tired' | 'angry' | 'meh'
  const lines = TEMPLATES[mood];         // 每种 mood 5–8 个模板
  const line = pickRandom(lines);
  return line
    .replace('${name}', petName)
    .replace('${tokens}', describeAmount(data.tokens))
    .replace('${compare}', describeCompare(data, data.yesterday))
    // …
}
```

模板池放 `src/renderer/dialogue/journal-templates.json`，分情绪分组。每组至少 8 条避免重复。

---

## 6. UI Spec

### 6.1 Onboarding 窗口

- 尺寸：400×520，居中，无边框、有阴影、不透明
- 不可拖到屏幕外 / 不可关闭（关掉等于退出 app）
- 字段：
  - 宠物名：input，2–20 字，placeholder "Mochi"
  - 人格内核：radio group（6 个预设）+ "自定义"展开 textarea（≤ 200 字，含计数器）
- "开始养我" 按钮：宠物名非空 && (预设已选 || 自定义文本 ≥ 5 字) 才启用

### 6.2 Journal 窗口

- 尺寸：380×460（贴近 v0.0.21 weekly card 比例）
- Game Boy 像素调色板：`#0f380f` `#306230` `#8bac0f` `#9bbc0f`（深浅四色）
- 字体：`Press Start 2P` 或现成的 pixel 字（沿用 weekly card 的字体配置）
- 布局：
  ```
  ╔══════════════════════════╗
  ║  ◆ 5月13日 周二 ☔     ║   ← 顶部 header bar
  ╠══════════════════════════╣
  ║                          ║
  ║  日记正文（最多约 200 字 ║
  ║  自动换行，字号 12px，   ║
  ║  行距 1.6）              ║
  ║                          ║
  ╠══════════════════════════╣
  ║  ◀ 5/12        5/14 ▶  ║   ← 翻页栏（disabled 状态变灰）
  ╚══════════════════════════╝
  ```
- 键盘快捷键：← / → 翻页
- 没有日记时全屏显示像素感的"再用我几天吧…"

### 6.3 Settings 新 card

```
┌─ 灵魂设定 ────────────────┐
│ 名字  [ Mochi          ] │
│                          │
│ 人格内核                 │
│ ○ 傲娇前架构师            │
│ ○ 老中医爷爷              │
│ ○ ...                    │
│ ● 自定义: [textarea]     │
│                          │
│  [ 保存灵魂 ]            │
└──────────────────────────┘
```

放在"AI 台词"之上（灵魂应当先于嘴）。

---

## 7. Phased Delivery

按"小步、可验证、每步都能 ship 半成品"原则拆。

### Phase 1 — Soul Kernel（~1 day）

- types.ts 扩展（onboarded, soulKernel）
- store.ts schema v4 migration
- soul.ts 预设字典 + composeSystemPrompt
- llm.ts 改用 composeSystemPrompt
- onboarding 窗口（最简版即可：名字 + 预设单选，先不做自定义）
- main 进程 onboarding 路由（未 onboarded → 不开 pet 窗口）
- settings 新增"灵魂设定" card

**Ship 标准**：新用户走完 onboarding，宠物用选定人格说话。本地台词不受影响。

### Phase 2 — Journal Backend（~1 day）

- journal.ts：列 / 读 / 写
- journal-template.ts：模板降级版
- LLM prompt 拼装 + 调用 + 落盘
- main 启动后 5s 调度生成昨日日记
- preload 暴露 IPC

**Ship 标准**：用户运行一天后，`~/.nom/journal/` 出现昨日 .md 文件，内容符合人格。

### Phase 3 — Journal Viewer（~1–2 days）

- journal/ 新 renderer entry
- Game Boy 像素 UI（复用 weekly card 的样式资源）
- 翻页交互 + 键盘快捷键
- 右键菜单"翻日记本"
- 日记生成完成时宠物气泡提示

**Ship 标准**：右键能翻日记，截图分享体验过关。

### Phase 4 — 自定义内核 + 打磨（~0.5 day）

- Onboarding 自定义 textarea
- Settings 同步加自定义
- 模板池扩到每个 mood ≥ 8 条
- 文案校验 / 边界情况打磨

---

## 8. Privacy

**新发出去的元数据**（仅在用户启用 LLM 时）：
- 宠物名 `petName`
- 人格内核文本 `soulKernel.text`（用户自己写的或他选的预设字符串）
- 昨日 token 总量 / 比对 / 时段 / idle / 里程碑等数字

**绝不发出**：
- prompt 内容（一直如此）
- Claude/Codex 回复内容（一直如此）
- 文件路径 / 项目名 / cwd

**用户控制**：
- 关闭 AI 台词 → 日记走模板版，零网络
- 删除 `~/.nom/journal/` → 所有日记消失，下次还会重新生成"昨天"那篇

需要在 README 隐私契约段补一句："开启 AI 台词后，发送的元数据现在还包含**宠物名 + 用户自填的人格内核文本**"。

---

## 9. Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| 用户自定义内核越狱 / 写攻击 prompt | 不必防。宠物是用户给自己用的，最差是宠物说脏话 —— 反而 funny。不做内容审核。 |
| LLM 生成日记很无聊 / 模式化 | Prompt 里强制"绝不复述数字"+ 人格内核兜底差异化。先小范围用一周观察，无聊就 prompt 迭代。 |
| 第一次启动用户嫌 onboarding 烦 | 强制 onboarding 是 deliberate decision —— 拿激活成本换"我的宠物"体验。如果装机数据显示流失高，再考虑 v2 加"跳过"逃生口。 |
| 日记生成失败 / 缺天 | 模板版兜底保证当天文件一定存在。 |
| 人格内核太长导致 prompt 超长 | 200 字硬截。 |
| 日记累积越来越多，目录爆炸 | 一天一个文件、文本极小（< 1KB），一年 365 个文件约 200KB 量级，无压力。 |

---

## 10. Open Questions

1. **预设人格的文本由谁写？** 我可以先草六个，PR 时让用户校验风格。或者用户更想要五个就好，少一个。
2. **日记可以"再生成"吗？** Phase 3 里加一个 debug 按钮（"重新写今天的日记"）？还是用户对"宠物自己写"的不可改逻辑买账？
3. **天气 emoji 是 LLM 自选还是按数据规则映射？** 自选更有人格、不准；规则映射稳定但呆。倾向自选 —— 反正不准也是宠物的特色。
4. **Onboarding 默认人格名字**？现在的 placeholder 是"Mochi"，要不要根据选的人格预填合适的名字？（"傲娇前架构师" → "老张"，"大唐妃子" → "如意"等）
5. **Journal 窗口大小固定还是可调**？倾向固定（保持像素风的"卡片感"），但有些日记会很短，固定大小可能上半截空。
6. **`composeSystemPrompt` 在 kernel 为 null 时用什么 fallback**？沿用当前"活泼贪吃嘴碎"那段？还是直接 fail loudly（理论上 onboarding 之后不会出现 null）？

---

## 11. Out of Scope (重申)

- 日记导出 PNG / 分享卡片
- 日记搜索
- 多语言
- 日记编辑 / 删除（用户可以 rm，但 app 不提供 UI）
- "宠物给你写信"
- 跨设备同步
- 装机量 / 留存埋点（我们没有服务端，主动埋点违反 nom 原则）
