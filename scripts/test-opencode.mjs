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
import { updateToFrames, stopReasonToFrame, runOpencodePrompt, findOpencodeBin } from '../host/opencode-bridge.js'

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

test('findOpencodeBin：只读 OPENCODE_BIN 环境变量', () => {
  assert.deepEqual(findOpencodeBin({ OPENCODE_BIN: '/x/opencode' }), { bin: '/x/opencode', prefixArgs: [] })
  assert.equal(findOpencodeBin({}), null)
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
