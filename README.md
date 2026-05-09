**English** | [简体中文](./README.zh-CN.md)

# nom

A desktop pet that lives on your screen and **eats the AI tokens you burn** — currently feeds on Claude Code (Codex / Cursor support coming).

> **Privacy first**: nom never sends your token data anywhere. It only reads usage numbers (not prompts/responses) from local transcripts, stores everything in `~/.nom/` on your machine, and you can `rm -rf ~/.nom` at any time.

## Features

- **Eats tokens in real time** — tails `~/.claude/projects/*.jsonl`, animates whenever Claude generates output.
- **Greets new sessions** — wakes up and bubbles a hello when you open a new Claude Code session.
- **Wanders on its own** — strolls around the screen between activity, like a real desktop companion (toggle off via right-click).
- **Skin support** — install any [petdex](https://github.com/crafter-station/petdex) pack with `npx petdex install <slug>`, then right-click → **选择宠物** to switch on the fly. No restart.
- **Sleeps when idle, wakes when you're back** — 30 min of silence and it dozes off.
- **Chat-card bubbles** — contextual lines on session start, milestones, click-to-talk, eating bursts. Local templates by default; **optional** LLM upgrade for dynamic, situation-aware lines (see below).
- **Drag anywhere** on the pet to move it; window position remembers across restarts.
- **Multi-display friendly** — `⌘⌥N` summons it back to whichever screen your cursor is on.

## Install (end users)

Grab the latest installer from [Releases](../../releases).

### macOS

- **Apple Silicon (M1/M2/M3/M4)**: `nom-x.y.z-arm64.dmg`
- **Intel Mac**: `nom-x.y.z-x64.dmg`

Drag `nom.app` into `/Applications`. First launch macOS will block it — go to **System Settings → Privacy & Security**, scroll to the bottom and click **Open Anyway** next to nom. Confirm in the dialog and it'll launch from then on.

### Windows

- `nom-x.y.z-setup.exe` — NSIS installer wizard, x64

Double-click the setup, walk through the wizard. You'll get a desktop shortcut and a Start Menu entry.

## Use a custom pet skin

Browse the catalogue at **[petdex.crafter.run](https://petdex.crafter.run/zh)** and install any pack:

```bash
npx petdex install boba       # or doraemon, goku-blue, ...
```

Right-click the pet → **选择宠物** → pick your new skin. Pets live in `~/.codex/pets/<slug>/` and `~/.nom/pets/<slug>/`.

## Right-click menu

| Item | What it does |
|---|---|
| ☑ 允许游走 | Toggle auto-wander on/off |
| ☐ AI 台词 | Toggle LLM-powered dialogue (see below) |
| 选择宠物 → | Switch among installed petdex skins |
| 打开配置文件 | Open `~/.nom/state.json` for manual edits |
| 关闭宠物 | Quit |

Plus a global shortcut: `⌘⌥N` (Mac) / `Ctrl+Alt+N` (Win) to summon the pet to the current screen.

## Optional: AI-powered dialogue

By default nom speaks from a local template file — fully offline, deterministic, no network. If you want context-aware lines (e.g. *"凌晨两点了还在用 Claude，你这个 prompt 写得有点暴躁啊"*), wire it to any **OpenAI-compatible chat-completions endpoint** — your own Anthropic key, an Ollama instance, a self-hosted model, anything that speaks the OpenAI API.

1. Right-click the pet → enable **AI 台词**
2. Right-click → **打开配置文件** (opens `~/.nom/state.json`)
3. Edit the `llm` block:
   ```json
   "llm": {
     "enabled": true,
     "endpoint": "https://api.anthropic.com/v1/...",
     "model": "claude-haiku-4-5-20251001",
     "apiKey": "sk-..."
   }
   ```
4. Quit and relaunch nom.

**Privacy contract**: only metadata (trigger type, time of day, token counts) ever leaves your machine. Your prompts and Claude's responses are **never** sent to the LLM endpoint. Failed / timed-out LLM calls silently fall back to the local templates — the pet keeps working even if your endpoint goes down.

## Develop

```bash
npm install
npm run dev          # electron-vite dev with HMR
npm run typecheck    # tsc --noEmit
npm run pack:mac     # build .dmg → release/
npm run pack:win     # build .exe → release/
```

Requires Node ≥ 18.

Architecture, technical decisions, and reasoning are in [`CLAUDE.md`](./CLAUDE.md). Product scope and out-of-scope items are in [`PRODUCT.md`](./PRODUCT.md).

## Privacy

nom is paranoid by design:

1. **No network calls by default.** The base experience is fully offline — everything ships from your local Claude Code transcripts. The optional AI dialogue feature is the only thing that can hit the network, and only when you explicitly enable it and configure an endpoint.
2. **No prompt/response content ever read or sent.** nom only parses `usage.{input,output,cache_*}_tokens` numbers from JSONL. When AI dialogue is on, only metadata (trigger, time, counts) goes to your LLM endpoint — never the actual conversation.
3. **All state local.** `~/.nom/state.json` is human-readable JSON. Nuke the dir to fully reset.

## License

[MIT](./LICENSE) for source code. Bundled sprite assets carry their own licenses — see [`CREDITS.md`](./CREDITS.md).
