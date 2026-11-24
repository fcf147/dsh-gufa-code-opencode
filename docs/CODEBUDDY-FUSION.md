# CodeBuddy 融合方案：dsh-gufa-code 外壳 + opencode Agent 后端

**决策日期**：2026-11-24
**用户决定**：切换融合路线——以 dsh-gufa-code 为基础（IDE 外壳），Agent 后端继续用 opencode。

---

## 1. 为什么这条路线

| 维度 | fork OpenCode desktop（旧路线） | dsh-gufa-code + opencode（新路线） |
|---|---|---|
| IDE 外壳 | 自己造（Monaco/多标签/Git/SSH/PTY 全重做） | **现成**，1.3.215，MIT，活跃维护 |
| Agent 面板 | 自己造（DomainEvent/状态机/视图） | 复用插件的 AI 面板骨架，后端换成 opencode |
| 宿主环境 | Electron renderer（node/browser 分离坑） | **DSH 插件 host = 纯 Node**，可直接 spawn 子进程 |
| 交付 | 自解压单文件 428MB | DSH 插件（`dsh plugin add`），且可复用 scb-release 单文件经验 |
| 已有资产 | ACP Spike 契约测试 + 反腐层 + Agent 面板状态机 | **全部可移植**（纯逻辑，无 UI 绑定） |

关键洞察：dsh-gufa-code 的 `host/*.js` 运行在 Node 环境（已大量使用 `node:child_process`），
我们之前写的 `AcpBridge` 正好是 Node 模块——**可以直接搬进来，没有浏览器限制**。

---

## 2. 架构

```
┌──────────────────────── DSH / dsh-gufa-code ────────────────────────┐
│  client.js（浏览器半，React，lazy-CJS 拼接 src/client/*.js）         │
│    ├─ 20-editor.js   Monaco 多标签/Git diff/跳转定义                │
│    ├─ 30-terminal.js xterm + WS PTY                                 │
│    ├─ 50-panels.js   资源管理器/Git/SSH                             │
│    ├─ 40-chat.js     AI 面板：G.stream('chat.stream', ...) ←───┐    │
│    └─ 60-dock.js     官方 DSH 会话停靠（保留，用户仍可用）       │    │
├────────────── /gufa-code/api/* (host，纯 Node) ─────────────────────┤
│    host/chat.js         DSH llm 驱动（保留）                        │
│    host/opencode.js ★   新增：opencode 驱动，复用 chat.stream SSE 帧 │
│      └─ AcpBridge（移植自 @codebuddy/adapter，spawn opencode acp）  │
│         ├─ initialize → session/new → session/prompt               │
│         ├─ session/update → DomainEvent(mapSessionUpdate)          │
│         └─ DomainEvent → SSE {type:'delta'|'thinking'|'done'|'error'}│
└─────────────────────────────────────────────────────────────────────┘
                              │ stdio JSON-RPC
                      opencode acp（Agent 引擎，v2.4.1）
```

**整合策略**：新增 `host/opencode.js`，输出与 `chat.stream` **完全相同的 SSE 帧格式**
（`{type:'delta',text}` / `{type:'thinking'}` / `{type:'done'}` / `{type:'error',message}`），
前端 `40-chat.js` 零改动即可通过切换端点使用 opencode 后端。

**右侧官方 DSH 会话不替换**（`60-dock.js` 保留）——它仍是 DSH 原生会话，用户可继续用；
opencode Agent 通过左侧 IDE 的 AI 面板提供服务。两种 Agent 并存，用户可选。

---

## 3. 已移植资产（从 opencode fork 分支）

| 资产 | 来源 | 移植方式 |
|---|---|---|
| ACP 契约测试（A2–A7，6 测试） | `opencode-full/codebuddy/spike/*.ndjson` | 保留为回归基线，host 模块单测复用 |
| AcpBridge（手写 JSON-RPC） | `packages/codebuddy-adapter/src/acp-bridge.ts` | 拷贝为 `host/opencode-bridge.js`（ESM，去 TS 类型） |
| DomainEvent 映射 | `src/domain-event.ts` | 拷贝为 `host/opencode-events.js` |
| Agent 面板状态机 | `src/agent-panel-machine.ts` | 暂不移植（前端继续用现有 chat 面板） |

---

## 4. opencode CLI 定位

host 启动时按优先级探测：
1. 环境变量 `OPENCODE_BIN`（绝对路径或 PATH 中的命令）
2. `scb-release.exe` 自解压后的 CLI（缓存目录）
3. 常见安装位置（`~/.bun/bin/opencode`、`/usr/local/bin/opencode` 等）

找不到时 `chat.info` 返回 `ready:false`，AI 面板明确提示，不影响 IDE 其它功能。

---

## 5. 里程碑

1. [x] fork 插件、建 `codebuddy-fusion` 分支、研究架构
2. [ ] 移植 AcpBridge + DomainEvent 为 host ESM 模块，写单测
3. [ ] 新增 `opencode.stream` SSE 端点，前端可切换后端
4. [ ] 端到端验证（真实 opencode CLI → client 面板流式文本）
5. [ ] 打包/分发（插件市场 + 可选单文件）

---

## 6. 踩坑备忘

- client.js 是**拼接产物**；改 `src/client/*.js` 后必须 `node scripts/build-client.mjs` 重新构建，否则不生效。
- host/*.js 按 mtime 代热重载，改完下一次请求自动生效；但改 `index.js` / `host/context.js` 需重启 DSH。
- 颜色只用主题 token，文案走 `t()`（i18n）。
- host 可直接 `import { spawn } from 'node:child_process'`（已有先例：dev.js / app-window.js）。
