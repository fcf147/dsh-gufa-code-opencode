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

export function register(router, env) {
  const ctx = env.ctx

  router.method('opencode.info', () => {
    const found = findOpencodeBin()
    return { ready: found !== null, bin: found === null ? null : found.bin }
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
