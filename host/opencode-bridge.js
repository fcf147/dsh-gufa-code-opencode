/**
 * opencode ACP 桥（移植自 opencode-full/codebuddy-adapter/src/acp-bridge.ts）。
 *
 * 纯 Node ESM：spawn `opencode acp`，手写 JSON-RPC over stdio，
 * 把 ACP session/update 映射为 chat.stream 兼容的 SSE 帧：
 *   { type: 'thinking' } / { type: 'delta', text } / { type: 'done' } / { type: 'error', message }
 *
 * 不 import host/context.js —— 便于在 Node 里直接单测（沿用 host/chat.js 的约定）。
 *
 * 契约依据：opencode-full v2.4.1 packages/cli/src/acp/* 与
 * codebuddy/spike/*.ndjson（A2–A7 真实录制帧）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mapSessionUpdate, mapPermissionRequest } from './domain-event.js'

/**
 * 把 ACP 的一条 session/update 映射为 0..N 个 SSE 帧。
 *
 * 走反腐层：ACP 原生 update → DomainEvent → SSE 帧。
 * 桥和上层都不直接消费 ACP 类型，OpenCode 契约变了只改 domain-event.js。
 */
export function updateToFrames(update) {
  if (update === null || typeof update !== 'object') return []
  const event = mapSessionUpdate('', update)
  switch (event.type) {
    case 'TextDelta':
      return event.text === '' ? [] : [{ type: 'delta', text: event.text }]
    case 'ThoughtDelta':
      return [{ type: 'thinking' }]
    case 'Ignored':
      // config_option_update / available_commands_update 等暂无 UI 需求，静默跳过。
      return []
    default:
      return []
  }
}

/** 把 prompt 的 stopReason 映射为终止帧。 */
export function stopReasonToFrame(stopReason) {
  if (stopReason === 'cancelled' || stopReason === 'refusal' || stopReason === 'error') {
    return { type: 'error', message: `opencode 会话结束：${stopReason}`, code: 'OPENCODE_STOP' }
  }
  return { type: 'done' }
}

/**
 * 启动一次 opencode acp 会话并推送 prompt。
 *
 * @param {object} options
 * @param {string} options.bin                opencode 可执行文件
 * @param {string[]} [options.prefixArgs]     前置参数（如 ['bash', shim]）
 * @param {string} options.cwd                工作目录
 * @param {string} options.prompt             用户输入
 * @param {(frame: object) => void} options.onFrame  SSE 帧回调
 * @param {(request: { id: number, toolCall: object, options: object[] }) => Promise<string>} [options.onPermission]
 *        权限决策回调，返回 'once' | 'always' | 'reject'；不传则默认 'reject'
 * @param {AbortSignal} [options.signal]      取消信号
 * @returns {Promise<{ stopReason: string }>}
 */
export function runOpencodePrompt(options) {
  const { bin, prefixArgs = [], cwd, prompt, onFrame, onPermission, signal } = options
  const child = spawn(bin, [...prefixArgs, 'acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let nextId = 0
  const pending = new Map()
  let thinkingSent = false
  let settled = false

  const send = (frame) => {
    if (frame.type === 'thinking' && thinkingSent) return
    if (frame.type === 'thinking') thinkingSent = true
    try { onFrame(frame) } catch { /* 客户端断开 */ }
  }

  const emitUpdate = (update) => {
    for (const frame of updateToFrames(update)) send(frame)
  }

  const handleLine = (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const slot = pending.get(message.id)
      if (slot !== undefined) {
        pending.delete(message.id)
        if (message.error !== undefined) slot.reject(new Error(message.error.message ?? 'ACP error'))
        else slot.resolve(message.result)
      }
      return
    }
    if (message.method === 'session/update') {
      const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
      emitUpdate(params.update)
      return
    }
    if (message.method === 'session/request_permission') {
      // 审批：走反腐层把 ACP params 转成 PermissionRequested，再交给上层（IDE 弹窗）。
      const id = typeof message.id === 'number' ? message.id : 0
      const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
      const event = mapPermissionRequest('', params)
      const decide = typeof onPermission === 'function'
        ? Promise.resolve(onPermission({
            id,
            toolCall: { name: event.name, toolCallId: event.callId, content: event.diff, rawInput: event.rawInput },
            options: event.options.map((optionId) => ({ optionId })),
          }))
        : Promise.resolve('reject')
      void decide.then((optionId) => {
        const choice = optionId === 'once' || optionId === 'always' ? optionId : 'reject'
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: choice } } })}\n`)
      }).catch(() => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } })}\n`)
      })
    }
  }

  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line !== '') handleLine(line)
      nl = buffer.indexOf('\n')
    }
  })

  const request = (method, params) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const abort = () => {
    if (settled) return
    settled = true
    try { child.kill() } catch { /* ignore */ }
  }
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) abort()
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true })
  }

  return (async () => {
    try {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'dsh-gufa-code', version: '1.0.0' },
      })
      const created = await request('session/new', { cwd, mcpServers: [] })
      const sessionId = created !== null && typeof created === 'object' ? created.sessionId : undefined
      if (typeof sessionId !== 'string') throw new Error('opencode session/new 未返回 sessionId')
      const result = await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      const stopReason = result !== null && typeof result === 'object' ? result.stopReason : 'end_turn'
      send(stopReasonToFrame(stopReason))
      return { stopReason }
    } catch (error) {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : String(error)
      send({ type: 'error', message: `opencode 请求失败：${message}`, code: 'OPENCODE_ERROR' })
      return { stopReason: 'error' }
    } finally {
      abort()
    }
  })()
}

/** 探测可用的 opencode CLI；返回 { bin, prefixArgs } 或 null。 */
export function findOpencodeBin(env = process.env) {
  if (typeof env.OPENCODE_BIN === 'string' && env.OPENCODE_BIN !== '') {
    return { bin: env.OPENCODE_BIN, prefixArgs: [] }
  }
  // 配置文件：插件 data 目录下的 opencode.json（{ bin, prefixArgs? }），无需重启进程即可生效。
  // 路径相对插件目录反推到 profile 的 plugin-data（host 每次请求热重载时读取，改配置立即生效）。
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const configFile = join(here, '..', '.codebuddy-opencode.json')
    if (existsSync(configFile)) {
      const config = JSON.parse(readFileSync(configFile, 'utf-8'))
      if (config !== null && typeof config === 'object' && typeof config.bin === 'string' && config.bin !== '') {
        return { bin: config.bin, prefixArgs: Array.isArray(config.prefixArgs) ? config.prefixArgs : [] }
      }
    }
  } catch {
    /* 配置不存在或非法：继续 */
  }
  return null
}
