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

`findOpencodeBin()` 按优先级探测：
1. 环境变量 `OPENCODE_BIN`（绝对路径或 PATH 中的命令）
2. 插件根目录的 `.codebuddy-opencode.json`：`{ "bin": "bash", "prefixArgs": ["<wrapper 绝对路径>"] }`
   —— 每次请求时读取，**改完不用重启 DSH**（host 按 mtime 热重载）
3. `PATH` 中的 `opencode`

找不到时 `opencode.info` 返回 `ready:false`，AI 面板明确提示，不影响 IDE 其它功能。

本机没有独立 opencode 二进制，用 `scripts/opencode-cli-wrapper.sh`（bun 从源码启动）包一层，
配置里 `bin: "bash"` + `prefixArgs: [wrapper]` 即可。

---

## 5. 里程碑

1. [x] fork 插件、建 `codebuddy-fusion` 分支、研究架构
2. [x] 移植 AcpBridge 为 host ESM 模块（`host/opencode-bridge.js`），6 个契约单测
3. [x] **移植 DomainEvent 反腐层**（`host/domain-event.js`，17 个契约测试）+ **Agent 面板状态机**（`host/agent-panel-machine.js`）
4. [x] 新增 `opencode.stream` SSE 端点 + `opencode.info`，前端运行时切换后端（标题栏按钮）
5. [x] 审批链路：`permission_request` SSE 帧 + `opencode.permission` 回传 + 端到端落盘验证
6. [x] 分发包：`pnpm pack` + 干净目录安装验证（`scripts/verify-tarball.mjs`）
7. [x] 全链路验证（本地 mock 上游，不依赖外部配额）
8. [ ] 真机 GUI 交互验证（需上游可用：点标题栏切换 → 发消息 → 审批弹窗）
9. [ ] 插件市场发布

### 反腐层的作用（为什么要有 domain-event.js）

```
ACP 原生 session/update ──► domain-event.js ──► DomainEvent ──► 外壳（桥/面板/IDE）
        ↑                        ↑                    ↑
   opencode 契约            唯一需要改的地方       稳定自研契约
```

opencode 升级导致 ACP 契约变化时，只改 `domain-event.js` 的映射，状态机和 UI 完全不动。
未知事件类型会映射成 `Ignored`（而不是静默丢弃），契约漂移能被测试发现。

### 安装到 DSH profile 的正确方式

**不要直接覆盖 `node_modules/dsh-gufa-code`** —— pnpm 会在下次 install 时把它还原成 registry 版本，
`index.js` 的 `MODULE_FILES` 和 `package.json` 版本都会回退（踩过）。

正确做法：profile 的 `package.json` 里把依赖指到本地 fork：

```json
"dsh-gufa-code": "file:D:/Desktop/self_codebuddy/dsh-gufa-code"
```

然后 `pnpm install`。之后改 fork 源码 → 重新 `pnpm install`（或重建 client.js 后 install）即可。

**但 `file:` 依赖仍是副本，且 pnpm 会缓存** —— 新增文件（如 `host/domain-event.js`）即使 `--force` 也不会同步过去。

开发期最省事的是直接用 **Windows junction** 指向 fork：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-gufa-code"
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-gufa-code" `
  -Target "D:\Desktop\self_codebuddy\dsh-gufa-code"
```

这样 fork 里改任何文件（含新增）都实时生效，不需要重装。
注意：junction 之后 `.codebuddy-opencode.json` 要写在 **fork 目录**里（已在 `.gitignore`）。
`pnpm install` 会覆盖 junction 回副本，重装后需重建 junction。

### 免费模型配额

opencode 走 OpenRouter 免费模型时有每日配额。实测（2026-11）：

```
X-RateLimit-Limit:     50          # 每天 50 次
X-RateLimit-Remaining: 0           # 已用尽
X-RateLimit-Reset:     <UTC 次日 00:00>   # 北京时间 08:00 重置
total_credits:         0           # 账号余额为 0
```

用尽后请求返回 error 帧（`code: 'OPENCODE_ERROR'`），IDE 面板正常显示错误、不崩溃。
这是外部限制，不是链路故障——`scripts/verify-installed-opencode.mjs` 会单独识别这种情况。

**排查提示**：先直连探测，排除代理干扰：

```sh
curl -s -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"nvidia/nemotron-3.5-super-vl:free","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

看 `X-RateLimit-*` 响应头即可确认是配额问题还是网络/代理问题。
想立刻恢复：充值 $10 解锁 1000 次/天，或换一个非 `:free` 的模型。

### 上游不可用时如何验证（重要）

账号可能遇到与代码无关的上游拒绝。实测遇到过：

```
{"error":{"message":"Request path cannot be relayed","code":400}}
x-openrouter-error-origin: client
```

该错误对**所有模型、所有请求形态**（含 `openrouter/auto`、非流式、IPv4 强制）都返回，
而 `/api/v1/key` 显示 `usage_daily: 0`、`is_free_tier: true`、key 未禁用——
即配额已重置但请求仍被拒，属账号/地区层面限制，与插件实现无关。

**因此不要依赖真实上游做回归验证**，用本地 mock：

```sh
# 终端 A：起 mock 上游（OpenAI 兼容，支持流式）
node scripts/mock-openai-server.mjs 18080

# 终端 B：跑全链路验证
node scripts/verify-with-mock.mjs 18080
```

`verify-with-mock.mjs` 会在临时工作目录写一个指向 mock 的 `opencode.json`
（`providers.mockprovider` + `@opencode/ai/providers/openai-compatible`），
然后走完整链路：**桥接模块 → ACP 子进程 → HTTP 上游 → 流式解析 → SSE 帧**。

实测输出：

```
frames: [{"type":"delta","text":"你好呀"},{"type":"done"}]
stopReason: end_turn
✓ 全链路通过：桥 → ACP → mock 上游 → 流式帧 → done
```

这条路径把「我们的实现是否正确」与「上游是否可用」彻底解耦。

---

## 6. 踩坑备忘

- client.js 是**拼接产物**；改 `src/client/*.js` 后必须 `node scripts/build-client.mjs` 重新构建，否则不生效。
- host/*.js 按 mtime 代热重载，改完下一次请求自动生效；但改 `index.js` / `host/context.js` 需重启 DSH。
- 颜色只用主题 token，文案走 `t()`（i18n）。
- host 可直接 `import { spawn } from 'node:child_process'`（已有先例：dev.js / app-window.js）。
- **覆盖 `node_modules` 会被 pnpm 还原**：必须用 profile `package.json` 的 `file:` 依赖（见上）。
- 审批决策存在 `globalThis.__gufaCodebuddyApprovals__`，跨 host 热重载代保持；60s 无响应默认 reject。
- `edit` 工具改 CRLF 文件会整体转 LF；需要保 CRLF 时用 Python `newline=''` 或 `\r\n`。
