# nom

A desktop pet that lives on your screen and **eats the AI tokens you burn** — currently feeds on Claude Code (Codex / Cursor support coming).

> **Privacy first**: nom never sends your token data anywhere. It only reads usage numbers (not prompts/responses) from local transcripts, stores everything in `~/.nom/` on your machine, and you can `rm -rf ~/.nom` at any time.

## Features

- **Eats tokens in real time** — tails `~/.claude/projects/*.jsonl`, animates whenever Claude generates output.
- **Knows when Claude is thinking** — shows a `Claude · 思考中…` card above its head from the moment you press enter to the moment a reply lands.
- **Greets new sessions** — wakes up and bubbles a hello when you open a new Claude Code session.
- **Wanders on its own** — strolls around the screen between activity, like a real desktop companion (toggle off via right-click).
- **Skin support** — install any [petdex](https://github.com/crafter-station/petdex) pack with `npx petdex install <slug>`, then right-click → **选择宠物** to switch on the fly. No restart.
- **Sleeps when idle, wakes when you're back** — 30 min of silence and it dozes off.
- **Talks** — milestones, time-of-day greetings, eating remarks, all from local dialogue files. **No LLM calls, ever.**
- **Drag anywhere** on the pet to move it; window position remembers across restarts.
- **Multi-display friendly** — `⌘⌥N` summons it back to whichever screen your cursor is on.

## Install (end users)

Grab the latest `.dmg` from [Releases](../../releases). **macOS only for now**; Windows builds are planned.

- **Apple Silicon (M1/M2/M3/M4)**: `nom-x.y.z-arm64.dmg`
- **Intel Mac**: `nom-x.y.z-x64.dmg`

Because nom isn't code-signed yet, macOS Gatekeeper will say it's "damaged". Fix it once after install:

```bash
xattr -cr /Applications/nom.app
```

Then open normally. (Future versions will be signed + notarized.)

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
| 选择宠物 → | Switch among installed petdex skins |
| 关闭宠物 | Quit |

Plus a global shortcut: `⌘⌥N` (Mac) / `Ctrl+Alt+N` (Win) to summon the pet to the current screen.

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

1. **No network calls.** Verify in `package.json` — there's no HTTP client dependency.
2. **No prompt/response content read.** It only parses `usage.{input,output,cache_*}_tokens` numbers from JSONL.
3. **All state local.** `~/.nom/state.json` is human-readable JSON. Nuke the dir to fully reset.

## License

[MIT](./LICENSE) for source code. Bundled sprite assets carry their own licenses — see [`CREDITS.md`](./CREDITS.md).
