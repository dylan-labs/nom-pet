# CLAUDE.md — nom 工程上下文

> 这个文件告诉未来的 Claude 会话：nom 是什么、技术栈定了什么、为什么这么定。**修改技术栈前先读这个文件，并在改动后更新它。**

产品定义在 `PRODUCT.md`，这里只讲工程。

---

## TL;DR

- **是什么**：桌面虚拟宠物，吃 AI 客户端消耗的 token。
- **形态**：Shimeji 风 —— 透明、无边框、置顶的悬浮小窗口，停在桌面某处。
- **运行方式**：装 `.dmg`（Mac）/ `.exe`（Win）。**不再是 npx**。
- **技术栈**：Electron 32 + electron-vite + React 18 + TypeScript。
- **数据源**：tail `~/.claude/projects/*.jsonl`（v1 仅 Claude Code）。
- **MVP 不做**：进化、多客户端、点击穿透、自动开机启动、托盘图标。详见 `PRODUCT.md`。

> **本项目曾短暂选过"终端 TUI + npx"路线**，但用户的硬要求是"宠物必须可见在桌面上"，因此整体转向 Electron 桌面应用。原 Ink/TUI 脚手架已废弃。

---

## 关键技术决策（含理由）

### 1. Electron + electron-vite
- **为什么**：跨平台 Mac+Win 一套代码；透明置顶动画用 Web 技术做最快；electron-vite 把 main/preload/renderer + HMR 打包好了，不用手撸 webpack。
- **代价**：包 80–150 MB；启动 2–3s；内存占用比原生大 5–10x。接受。
- **不选 Tauri**：用户已选 Electron。Tauri 包小但 Rust 工具链门槛 + Linux webview 一致性差。
- **不选原生**：两套代码、开发量翻倍，不值得。

### 2. 透明置顶 Shimeji 风窗口
- **`BrowserWindow` 关键参数**：
  ```ts
  { transparent: true, frame: false, hasShadow: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, backgroundColor: '#00000000' }
  ```
- **macOS 还要**：
  - `win.setAlwaysOnTop(true, 'screen-saver')` —— 高于全屏 App
  - `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
  - `app.dock?.hide()` —— 不在 Dock 显示
- **窗口大小**：v1 固定（如 200×200），尽量贴合宠物剪影，减少透明区误点击的足迹。
- **拖动**：用 CSS `-webkit-app-region: drag`（整窗 drag，宠物本身和气泡 `no-drag` 接收点击）。
- **位置记忆**：每次拖完保存到 `~/.nom/state.json` → 启动时恢复。
- **多屏**：v1 不刻意支持，启动放主屏右下角；用户拖到哪保存哪。

### 3. 不做点击穿透（v1）
- 真正的"透明像素鼠标穿透"需要 `setIgnoreMouseEvents(true, { forward: true })` + 实时 hit-test，复杂度高。v1 接受窗口框范围内全部捕获鼠标。
- 缓解：窗口做小、贴合宠物；用户可以拖到不挡事的位置。

### 4. Token 数据源 —— Claude Code transcripts（不变）
- **怎么拿**：Claude Code 把每次会话写到 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`，每行一个事件；assistant 消息事件里有 `message.usage.input_tokens` / `output_tokens` / `cache_*_tokens`。
- **实现**：main 进程跑 `chokidar`，监听 `~/.claude/projects/` 递归变更 → 新行 append → 解析 → token 累加 → 通过 IPC 推到 renderer。
- **为什么不用 hooks**：保留"零侵入"原则，不修改用户的 `~/.claude/settings.json`。
- **为什么不接 Cursor/Codex（v1）**：Cursor 没有可靠本地用量文件；Codex CLI 格式不稳定。v2 再做适配器。
- **解析容错**：JSONL 行可能写一半（Claude Code 还在写），逐行 try/catch，失败就跳过。

### 5. IPC 架构（main / preload / renderer 三段）
- **main**：window 管理、文件监听、`~/.nom/` 持久化、定时器、对外不可见的逻辑全在这里。
- **preload**：`contextBridge.exposeInMainWorld('nom', { ... })` 暴露受控 API 给 renderer。**严禁** `nodeIntegration: true` 或直接暴露 `ipcRenderer`。
- **renderer**：纯 React UI，不直接碰 fs / Node API，所有 IO 走 preload 暴露的接口。
- **IPC 事件命名约定**：`nom:tokens:eaten`、`nom:state:get`、`nom:dialogue:speak`、`nom:window:drag-end`。

### 6. 持久化
- **位置**：`~/.nom/state.json`（用 `os.homedir()` + `path.join`，跨平台）
- **内容**：宠物总累计 token、每日用量、最近 N 天历史、上次启动时间、窗口位置 `{x, y, displayId}`。
- **格式**：人可读 JSON，方便用户检查 / 删除。
- **写时机**：debounce 1s 写盘，避免每个 token 事件都写。

### 7. 美术资源约定
- **第一版（v0.0.x）**：用 emoji 或 inline SVG 占位，**让窗口能跑起来**，先不投美术。
- **正式版（v1.0）**：原创像素角色，单帧 64×64 或 128×128，PNG 透明背景；状态分目录：`assets/sprites/<state>/<frame>.png`。每个状态多帧做循环动画，CSS animation 切帧。
- **可选**：未来若需要更复杂动画再考虑 Lottie。

### 8. "冒泡说话"（不变）
- **机制**：纯本地预置台词库，**绝不调任何 LLM**（成本 + 隐私 + 离线）。
- **触发条件**：点击宠物 / 里程碑（每 10K token）/ 闲置（>30min 无事件）/ 启动 / 退出 / 每日小结。
- **台词存放**：`src/renderer/dialogue/<trigger>.json`，方便后续翻译多语言。
- **气泡 UI**：渲染在宠物正上方的 SVG / div，3 秒后自动消失。

### 9. 分发：electron-builder
- **targets**：`dmg`（macOS）+ `nsis`（Windows）。
- **配置文件**：`electron-builder.yml`（项目根）。
- **签名**：v1 不做。README 写明 macOS 用户首次打开要 `右键 → 打开`，Windows 用户要点"仍然运行"。
- **发布**：手动上传 GitHub Releases；自动更新留 v2。

---

## 目录结构（计划）

```
nom/
├── PRODUCT.md
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── electron.vite.config.ts
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts          # Electron main entry
│   │   ├── window.ts         # createPetWindow（透明置顶）
│   │   ├── ipc.ts            # IPC handlers
│   │   └── data/
│   │       ├── claude-source.ts   # tail ~/.claude/projects/
│   │       ├── parser.ts          # JSONL → token 事件
│   │       └── store.ts           # ~/.nom/state.json 读写
│   ├── preload/
│   │   └── index.ts          # contextBridge
│   └── renderer/
│       ├── index.html
│       ├── main.tsx          # React entry
│       ├── App.tsx           # 顶层组件
│       ├── index.css         # 全局透明 body
│       ├── components/
│       │   ├── Pet.tsx       # 宠物 sprite
│       │   └── Bubble.tsx    # 对话气泡
│       └── dialogue/
│           ├── milestone.json
│           ├── idle.json
│           └── greeting.json
├── assets/
│   └── sprites/
│       ├── idle/
│       ├── eating/
│       ├── sleeping/
│       └── talking/
├── out/                      # electron-vite 输出（gitignore）
└── release/                  # electron-builder 输出（gitignore）
```

## 跨平台注意事项

- **路径**：永远用 `path.join` + `os.homedir()`。
- **`~/.claude/projects/`**：Mac/Linux `~/.claude/...`，Windows `%USERPROFILE%\.claude\...`。`os.homedir()` 自动处理。
- **alwaysOnTop**：macOS 必须 `'screen-saver'` level + `setVisibleOnAllWorkspaces` 才能盖住全屏 App；Win 默认就行。
- **chokidar**：Win 偶尔丢事件，加 `usePolling: true` 兜底（性能损失小，对低频日志没影响）。
- **dock / 任务栏**：macOS `app.dock?.hide()`，Win `skipTaskbar: true`。
- **退出**：Win 关掉所有窗口就 quit；macOS 默认不 quit（按 Cmd+Q 才退）。我们 v1 让两个平台行为一致：所有窗口关掉就退。

## 开发命令

```bash
npm install
npm run dev          # electron-vite dev（HMR + 自动启 Electron）
npm run build        # electron-vite build → out/
npm run typecheck    # tsc --noEmit
npm run pack         # electron-builder → release/
npm run pack:mac     # 只打 mac
npm run pack:win     # 只打 win
```

## 工程原则

1. **用户给的"先做最小可用"是硬约束**。每次想加功能前对照 `PRODUCT.md` 的 Out of Scope，超出的写到 issue 不写到代码。
2. **零侵入数据采集**。绝不修改用户的 `~/.claude/settings.json` 或其他工具的配置。
3. **隐私三原则**（见 `PRODUCT.md`）—— 任何涉及网络请求的 PR 直接拒。
4. **跨平台是发布门槛**。任何 PR 必须在 Mac + Win 各跑一遍截图。
5. **renderer 不碰 Node API**。所有 IO / fs 操作走 main，preload 透传。违反这条的 PR 直接拒（安全模型）。
6. **不引入大依赖**。Electron 已经够大了，别再叠 Tailwind / MUI / 状态管理库。CSS 手写，状态用 React `useState/useReducer`。

## 当前阶段

**Electron 脚手架阶段**（v0.0.2）。
- 已有 PRODUCT.md / CLAUDE.md（本文件）+ 旧 Ink 脚手架已清理。
- 下一步：搭 electron-vite 工程骨架 + 一个透明置顶窗口 + emoji 占位宠物 + 点击对话 + 拖动。验证全链路工具链。
