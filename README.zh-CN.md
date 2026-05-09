[English](./README.md) | **简体中文**

# nom

一只住在桌面上的宠物，**吃掉你消耗的 AI token** —— 当前从 Claude Code 取食（Codex / Cursor 适配在路上）。

> **隐私优先**：nom 不向任何地方上传你的数据。它只读用量数字（不读 prompt/response），所有状态存在你机器上的 `~/.nom/`，随时可以 `rm -rf ~/.nom` 清空。

## 功能

- **实时吃 token** —— 监听 `~/.claude/projects/*.jsonl`，Claude 一出 token 就嚼。
- **知道 Claude 在思考** —— 你按下回车的瞬间到回复落地，宠物头顶都挂着 `Claude · 思考中…` 卡片。
- **新会话问候** —— 你打开新 Claude Code 会话，宠物会醒过来打招呼。
- **自动游走** —— 没事自己在桌面溜达两步，像个真实的桌面伙伴（右键可关）。
- **支持换皮** —— 用 `npx petdex install <slug>` 装 [petdex](https://github.com/crafter-station/petdex) 包，再右键 → **选择宠物** 秒切，不用重启。
- **闲置睡觉、回来唤醒** —— 30 分钟没动静就打盹。
- **会说话** —— 里程碑、时段问候、吃东西吐槽，全部来自本地台词文件。**绝不调用任何 LLM。**
- **拖动** 任意位置即可移动；窗口位置重启不丢。
- **多屏友好** —— `⌘⌥N` 一键召回到鼠标所在屏幕。

## 安装（最终用户）

到 [Releases](../../releases) 下载对应平台的安装包。

### macOS

- **Apple Silicon（M1/M2/M3/M4）**：`nom-x.y.z-arm64.dmg`
- **Intel Mac**：`nom-x.y.z-x64.dmg`

把 `nom.app` 拖进 `/Applications`。首次打开 macOS 会拦截 —— 打开 **系统设置 → 隐私与安全性**，拉到底，点 nom 旁边的 **仍然打开**，弹窗里再确认一次就行，以后双击直接启动。

### Windows

- `nom-x.y.z-setup.exe` —— NSIS 安装向导，x64

双击 setup，走完向导。桌面会有快捷方式，开始菜单也能找到。

## 换宠物皮肤

到 **[petdex.crafter.run](https://petdex.crafter.run/zh)** 浏览所有可装的宠物，安装：

```bash
npx petdex install boba       # 或 doraemon、goku-blue……
```

右键宠物 → **选择宠物** → 选你新装的。宠物文件存在 `~/.codex/pets/<slug>/` 和 `~/.nom/pets/<slug>/`。

## 右键菜单

| 选项 | 作用 |
|---|---|
| ☑ 允许游走 | 自动游走开/关 |
| 选择宠物 → | 在已装的 petdex 皮肤之间切换 |
| 关闭宠物 | 退出 |

另外有全局快捷键：`⌘⌥N`（Mac）/ `Ctrl+Alt+N`（Win），把宠物召回到当前屏幕。

## 开发

```bash
npm install
npm run dev          # electron-vite dev 模式（带 HMR）
npm run typecheck    # tsc --noEmit
npm run pack:mac     # 打 .dmg → release/
npm run pack:win     # 打 .exe → release/
```

需要 Node ≥ 18。

架构、技术决策和理由见 [`CLAUDE.md`](./CLAUDE.md)。产品范围和不做的事见 [`PRODUCT.md`](./PRODUCT.md)。

## 隐私

nom 在隐私上是偏执的：

1. **零网络请求**。`package.json` 里没有任何 HTTP 客户端依赖，自己可以验证。
2. **不读 prompt/response 内容**。只解析 JSONL 里的 `usage.{input,output,cache_*}_tokens` 数字。
3. **所有状态本地**。`~/.nom/state.json` 是人可读 JSON，删掉就完全重置。

## 许可证

源码用 [MIT](./LICENSE)。打包进去的 sprite 素材有各自的许可证，见 [`CREDITS.md`](./CREDITS.md)。
