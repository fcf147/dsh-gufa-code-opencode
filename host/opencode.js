/**
 * opencode 后端路由：把 gufa-code 的 AI 面板接到 opencode ACP 引擎。
 *
 * 路由（挂在 /gufa-code/api 下）：
 *   POST opencode.info   → { ready, bin }
 *   POST opencode.stream → text/event-stream，帧格式与 chat.stream 一致
 *
 * 请求体与 chat.stream 兼容：
 *   { messages: [{role, content}], context: {...} }
 * 只取最后一条 user 消息作为 prompt（ACP 会话自身维护历史）。
 */

import { findOpencodeBin, runOpencodePrompt } from './opencode-bridge.js'

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** 挂起的审批决策：requestId -> { resolve, timer }；放 globalThis 以跨 host 热重载代保持。 */
const APPROVALS_KEY = '__gufaCodebuddyApprovals__'
function approvals() {
  if (globalThis[APPROVALS_KEY] === undefined) globalThis[APPROVALS_KEY] = new Map()
  return globalThis[APPROVALS_KEY]
}

export function register(router, env) {
  const ctx = env.ctx

  router.method('opencode.info', () => {
    const found = findOpencodeBin()
    return { ready: found !== null, bin: found === null ? null : found.bin }
  })

  /** 前端审批弹窗回传决策：{ requestId, decision: 'once'|'always'|'reject' } */
  router.method('opencode.permission', (body) => {
    const requestId = body !== null && typeof body === 'object' ? Number(body.requestId) : NaN
    const decision = body !== null && typeof body === 'object' ? textOf(body.decision) : ''
    const pending = approvals().get(requestId)
    if (pending === undefined) return { ok: false, error: '审批请求不存在或已超时' }
    clearTimeout(pending.timer)
    approvals().delete(requestId)
    pending.resolve(decision === 'once' || decision === 'always' ? decision : 'reject')
    return { ok: true }
  })

  router.stream('opencode.stream', async (body, { signal, send, close }) => {
    const found = findOpencodeBin()
    if (found === null) {
      send({ type: 'error', message: '未找到 opencode CLI，请设置 OPENCODE_BIN 环境变量。', code: 'NO_OPENCODE_BIN' })
      close()
      return
    }
    const messages = body !== null && typeof body === 'object' && Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find((m) => m !== null && typeof m === 'object' && m.role === 'user')
    const prompt = textOf(lastUser !== undefined ? lastUser.content : '')
    if (prompt === '') {
      send({ type: 'error', message: '请输入问题。', code: 'EMPTY_PROMPT' })
      close()
      return
    }
    const context = body !== null && typeof body === 'object' && body.context !== null && typeof body.context === 'object'
      ? body.context
      : {}
    // 把选中的代码/当前文件作为上下文前缀（与 chat.stream 的 ContextBuilder 口径一致）。
    const selection = textOf(context.selection)
    const fileContent = textOf(context.content)
    const prefix = selection !== ''
      ? `参考代码（${textOf(context.selectionPath)}）：\n${selection}\n\n`
      : fileContent !== '' ? `当前文件（${textOf(context.path)}）：\n${fileContent}\n\n` : ''
    const cwd = textOf(context.root) || process.cwd()

    try {
      await runOpencodePrompt({
        bin: found.bin,
        prefixArgs: found.prefixArgs,
        cwd,
        prompt: `${prefix}${prompt}`,
        onFrame: (frame) => send(frame),
        onPermission: (request) => new Promise((resolve) => {
          const requestId = request.id
          const toolCall = request.toolCall !== null && typeof request.toolCall === 'object' ? request.toolCall : {}
          const options = Array.isArray(request.options) ? request.options : []
          const diff = Array.isArray(toolCall.content)
            ? toolCall.content.filter((item) => item !== null && typeof item === 'object' && item.type === 'diff')
            : []
          // 通知前端弹审批窗；前端用 opencode.permission 回传决策。
          send({
            type: 'permission_request',
            requestId,
            tool: textOf(toolCall.name),
            title: textOf(toolCall.title),
            diff,
            options: options.map((o) => textOf(o.optionId)),
          })
          const timer = setTimeout(() => {
            if (approvals().has(requestId)) {
              approvals().delete(requestId)
              resolve('reject')
            }
          }, 60_000)
          approvals().set(requestId, { resolve, timer })
        }),
        signal,
      })
    } catch (error) {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error)
      send({ type: 'error', message: `opencode 桥接失败：${message}`, code: 'OPENCODE_BRIDGE_ERROR' })
    } finally {
      close()
    }
  })
}
