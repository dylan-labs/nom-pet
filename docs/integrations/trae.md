# Trae 集成调研笔记（搁置 — 2026-05-11）

> 这份文档记录了**为什么 nom v1.x 不接入 Trae**。如果未来有人想再试一次，先读这个，能省一周。

## TL;DR

- 测试目标：[Trae SOLO CN](https://www.trae.com.cn)（字节版，bundle `cn.trae.solo.app`，Electron 32）
- 试过的路线：**J6**——改 Trae `package.json` 的 `main` 字段、植入自己的 ESM hook 到 Trae 主进程，在主进程 IPC（`webContents.send` / `webContents.postMessage` / `MessagePortMain.prototype.postMessage`）里抓 token usage 事件
- **结论**：**Trae 的 chat 数据完全不经过 main 进程**。Main 进程只看到 VS Code 内核 bootstrap、文件监听、系统遥测，没有任何 chat / token 字段。这是架构问题，不是字段名问题。

---

## Trae 的进程架构（实测出来的）

```
┌────────────────────────────────────────────────────────────────────────┐
│  Trae SOLO CN  (Electron app, 一个 main + 多个 helper)                  │
│                                                                         │
│  ┌──────────┐                                                          │
│  │   main   │  ← package.json "main" 指向这里。我们 patch 的就是这个   │
│  │ (Electron)│    它只做窗口管理、文件监听、扩展宿主生命周期、系统遥测 │
│  └────┬─────┘                                                          │
│       │ spawn (utilityProcess.fork)                                    │
│       ▼                                                                │
│  ┌──────────────────┐    ┌──────────────────┐                          │
│  │  extension host  │    │   "ai" utility   │  <- 名字带 ai 的子进程   │
│  │  (Node sandbox)  │    │  (Node, vscode-  │                          │
│  └────────┬─────────┘    │  crash-reporter- │                          │
│           │              │  process-type=ai)│                          │
│           │              └────────┬─────────┘                          │
│           │                       │ unix socket                        │
│           │                       │ (~/Library/Application             │
│           │                       │   Support/TRAE SOLO CN/            │
│           │                       │   1.10-main.sock)                  │
│           │                       ▼                                    │
│           │              ┌──────────────────┐                          │
│           │              │  ai-agent (Rust) │   ← 真正调 LLM 的进程    │
│           │              │  独立可执行      │                          │
│           │              └────────┬─────────┘                          │
│           │                       │ HTTPS                              │
│           │                       ▼                                    │
│           │              trae-api-cn.mchost.guru                       │
│           │                                                            │
│           │ VS Code 内部 RPC（pipe/socket）                             │
│           ▼                                                            │
│  ┌─────────────────────┐                                              │
│  │ workbench renderer  │                                              │
│  │ (Chromium)          │                                              │
│  └──────┬──────────────┘                                              │
│         │ vscode.postMessage (webview API)                            │
│         ▼                                                              │
│  ┌─────────────────┐                                                   │
│  │ chat webview    │  ← UI 显示 token 用量的地方                       │
│  │ (sandboxed)     │                                                   │
│  └─────────────────┘                                                   │
└────────────────────────────────────────────────────────────────────────┘
```

**关键事实**：token usage 从 Rust ai-agent 出来后，沿着 `ai utility ↔ extension host ↔ workbench renderer ↔ webview` 一路走，**main 进程完全不在路径上**。Main 只是个壳。

---

## 我们走过的路（按时间）

1. **零侵入 tail（失败）**：Trae 把会话存在 `~/Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/database.db`，但**SQLCipher 加密**，钥匙在 Keychain。明文日志（`logs/*.log`）零 token 字段。
2. **方案 B：写 VS Code 扩展用 `vscode.lm`（失败）**：Trae 的 chat 走 ai-agent 私有 IPC，**不经过 `vscode.lm`**，扩展看不到。
3. **方案 J6：patch `package.json` 的 main 入口（最终走通了 patch 但抓不到数据）**：
   - patch 部分完美工作 —— 写 hook、监听 macOS App 管理授权、Trae 自动更新检测、disconnect 还原全跑通
   - hook 部分确实拦到了所有 main 进程 IPC（`webContents.send` ×800/s、`webContents.postMessage`、`MessagePortMain.prototype.postMessage`）
   - 抓到的 channel 列表（chat 期间）：`vscode:message`、`vscode:main::sandbox-*`、`vscode:icube.resource_usage`、`vscode:icube.memory_risk_status`
   - 抓到的 payload 形状：扩展元数据、主题、字体、键盘布局、文件监听、系统配置 —— **没有一个跟 chat 沾边**

我们用了几轮诊断仪器化确认这一点（chokidar 看不出来 → 加 hook diagnostic → 加 buffer 探针 → 加 MessagePort 包装 → 加 channel 频率统计），最后跑出来 chat 时段 channel 总数从 8 增长到 10，新增的都是无关的扩展元数据加载。

## 后续可能的路（如果哪天有人重新做）

按"性价比"排序：

### A. 等 Trae 暴露官方接口
- 字节如果在 Trae 里实现 VS Code 的 [`vscode.lm` API](https://code.visualstudio.com/api/extension-guides/language-model)，写个扩展几十行搞定。
- 或者 Trae 直接学 Claude Code 把 transcripts 写到 `~/.trae/sessions/*.jsonl`。
- **行动**：定期看 Trae 的 changelog 和 [GitHub issues](https://github.com/Trae-AI)（如果他们开源任何东西）。

### B. Patch 扩展宿主（utilityProcess）
- 在 main 里 monkey-patch `electron.utilityProcess.fork`，往子进程注入我们的 hook
- 在 ext host 进程里再 hook 它跟 ai-agent 的 unix socket / 跟 renderer 的 RPC
- **估**：2-3 天工作量、50/50 走通、Trae 每次大版本都可能崩、协议都是二进制的解码工作量未知

### C. HTTPS MITM 拦 ai-agent 出口
- 在本机起个代理，让 Trae 的 `ai-agent` 走 `localhost:NNNN`，截获到 `trae-api-cn.mchost.guru` 的响应
- 需要用户安装 nom 自签的 CA，麻烦死
- 协议未知（HTTP+JSON 还是 gRPC 二进制？需要先抓包）

### D. WAL 心跳模式（之前否决的方案）
- 监听 `database.db-wal` 体积增长，按字节×固定系数估算 token
- **形状对、数字假**。会让里程碑/等级失真，PRODUCT.md 第三页明确不要假数字，所以 v1 不该走

---

## 测试环境快照

- 日期：2026-05-11
- macOS：Darwin 25.4.0
- Trae 版本：TRAE SOLO CN (cn.trae.solo.app)
  - Electron 32.x
  - 签名：Developer ID Application: Beijing Yinli Catapult Technology Co., Ltd. (CG2SCM6AV5)
  - Hardened runtime：是。**没有** `allow-dyld-environment-variables` 也没有 `disable-library-validation` → DYLD_INSERT_LIBRARIES / NODE_OPTIONS 注入都被堵
  - `package.json`: `"main": "./out/main.js"`, `"type": "module"`
- 测试样本：在 Trae 里发了 3-4 条 chat，每条等 assistant 完整回完

## 如果用户机器上还有残留

Trae 自动更新会覆盖我们的 patch（main 字段恢复成 `./out/main.js`、`nom-trae-hook.mjs` 文件可能还在）。这些残留**无害**：

- `nom-trae-hook.mjs` 没有被引用就是死代码，不会执行
- `~/.nom/sources/trae.jsonl` 是过期数据源，没有 nom 代码会读它
- `~/.nom/trae-state.json` 同理

主动清理：

```bash
# 1. 如果 Trae 还被 patch（main 仍指向我们的 hook），用之前装着 Trae 集成的 nom 点一次"断开"。
#    或者手动还原（需要 macOS App 管理权限或管理员密码）：
osascript -e 'do shell script "sed -i \"\" \"s|./nom-trae-hook.mjs|./out/main.js|\" \"/Applications/TRAE SOLO CN.app/Contents/Resources/app/package.json\" && rm -f \"/Applications/TRAE SOLO CN.app/Contents/Resources/app/nom-trae-hook.mjs\"" with administrator privileges'

# 2. 清掉 nom 这边的残留
rm -rf ~/.nom/sources ~/.nom/trae-state.json
```
