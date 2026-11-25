/**
 * opencode 桥自测（Node 原生 test，无需 DSH 环境）。
 *   node --test scripts/test-opencode.mjs
 *
 * 覆盖：
 *  1. updateToFrames / stopReasonToFrame 纯映射（SSE 帧契约）
 *  2. runOpencodePrompt 真实 CLI 集成（需 OPENCODE_BIN + 可达的 opencode acp）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { updateToFrames, stopReasonToFrame, runOpencodePrompt, findOpencodeBin } from '../host/opencode-bridge.js'
import { register as registerOpencode } from '../host/opencode.js'

test('updateToFrames：文本/推理/元数据帧契约', () => {
  assert.deepEqual(updateToFrames({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好呀' } }),
    [{ type: 'delta', text: '你好呀' }])
  assert.deepEqual(updateToFrames({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } }),
    [{ type: 'thinking' }])
  assert.deepEqual(updateToFrames({ sessionUpdate: 'usage_update', used: 1, size: 10 }), [])
  assert.deepEqual(updateToFrames({ sessionUpdate: 'future_event' }), [])
  assert.deepEqual(updateToFrames(null), [])
})

test('stopReasonToFrame：正常结束与异常收敛', () => {
  assert.deepEqual(stopReasonToFrame('end_turn'), { type: 'done' })
  assert.equal(stopReasonToFrame('cancelled').type, 'error')
  assert.equal(stopReasonToFrame('refusal').type, 'error')
})

test('findOpencodeBin：环境变量优先，其次插件目录配置文件', () => {
  // 1. OPENCODE_BIN 环境变量优先级最高
  assert.deepEqual(findOpencodeBin({ OPENCODE_BIN: '/x/opencode' }), { bin: '/x/opencode', prefixArgs: [] })

  // 2. 环境变量缺失时读插件目录的 .codebuddy-opencode.json（开发机可能已配置）
  const found = findOpencodeBin({})
  if (found !== null) {
    assert.equal(typeof found.bin, 'string', '配置探测结果必须带 bin')
    assert.ok(Array.isArray(found.prefixArgs), 'prefixArgs 必须是数组')
  }
  // 未配置的仓库（CI / 干净检出）应返回 null；这里两种结果都合法，只校验形状。
})

test('opencode.permission：审批回传决策解析', async () => {
  const methods = new Map()
  const streams = new Map()
  registerOpencode(
    { method: (n, f) => methods.set(n, f), stream: (n, f) => streams.set(n, f) },
    { ctx: {} },
  )
  assert.ok(methods.has('opencode.permission'))
  assert.ok(streams.has('opencode.stream'))
  // 未挂起的请求返回失败
  const missing = await methods.get('opencode.permission')({ requestId: 99999, decision: 'once' })
  assert.equal(missing.ok, false)
})

const SHIM = process.env.OPENCODE_TEST_SHIM
const integration = test('runOpencodePrompt：真实 CLI 文本流', { skip: SHIM ? false : '需 OPENCODE_TEST_SHIM', timeout: 90000 }, async () => {
  const frames = []
  const result = await runOpencodePrompt({
    bin: 'bash',
    prefixArgs: [SHIM],
    cwd: tmpdir(),
    prompt: '只回复三个字：你好呀。不要解释。',
    onFrame: (frame) => frames.push(frame),
  })
  assert.equal(result.stopReason, 'end_turn')
  assert.ok(frames.some((f) => f.type === 'delta' && f.text.includes('你好呀')), '应收到文本增量')
  assert.equal(frames.at(-1).type, 'done')
  assert.ok(!frames.some((f) => f.type === 'error'), '不应有错误帧')
})

void integration

const approvalIntegration = test('审批端到端：权限请求回 once 后文件落盘', { skip: SHIM ? false : '需 OPENCODE_TEST_SHIM', timeout: 90000 }, async () => {
  const workspace = join(tmpdir(), `gufa-approval-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({ permission: { write: 'ask' } }))
  const frames = []
  let asked = null
  await runOpencodePrompt({
    bin: 'bash',
    prefixArgs: [SHIM],
    cwd: workspace,
    prompt: '用 write 工具创建 approved.txt，内容 APPROVED。只做这件事。',
    onFrame: (f) => frames.push(f),
    onPermission: (request) => {
      asked = request
      return Promise.resolve('once')
    },
  })
  assert.ok(asked !== null, '应收到权限请求')
  assert.equal(asked.toolCall.name, 'write')
  assert.ok(frames.some((f) => f.type === 'done' || f.type === 'error'))
  assert.equal(existsSync(join(workspace, 'approved.txt')), true, '回 once 后文件应落盘')
})
void approvalIntegration
