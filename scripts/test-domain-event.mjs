/**
 * 反腐层 + 状态机契约测试（移植自 opencode-full 的 TS 测试）。
 *
 * 这些是「技术资产」：OpenCode 契约演进时，改映射不动状态机，
 * 测试守住两侧的契约边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapSessionUpdate, mapPermissionRequest, mapPromptResult } from '../host/domain-event.js'
import { initialPanelState, transition, needsApproval } from '../host/agent-panel-machine.js'

// ---------- 反腐层：ACP → DomainEvent ----------

test('mapSessionUpdate: 文本块 → TextDelta', () => {
  const event = mapSessionUpdate('s1', {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'm1',
    content: { type: 'text', text: '你好' },
  })
  assert.deepEqual(event, { type: 'TextDelta', sessionId: 's1', messageId: 'm1', text: '你好', source: 'live' })
})

test('mapSessionUpdate: 推理块 → ThoughtDelta', () => {
  const event = mapSessionUpdate('s1', {
    sessionUpdate: 'agent_thought_chunk',
    messageId: 'm2',
    content: { text: '思考中' },
  })
  assert.equal(event.type, 'ThoughtDelta')
  assert.equal(event.text, '思考中')
})

test('mapSessionUpdate: user_message_chunk 标 replay 来源', () => {
  const event = mapSessionUpdate('s1', {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u1',
    content: { text: '用户说的话' },
  })
  assert.equal(event.type, 'TextDelta')
  assert.equal(event.source, 'replay')
})

test('mapSessionUpdate: tool_call → ToolCallStarted', () => {
  const event = mapSessionUpdate('s1', {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'write',
  })
  assert.deepEqual(event, { type: 'ToolCallStarted', sessionId: 's1', callId: 'c1', name: 'write', status: 'pending' })
})

test('mapSessionUpdate: tool_call_update 状态收敛', () => {
  const done = mapSessionUpdate('s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'write', status: 'completed' })
  assert.equal(done.type, 'ToolCallCompleted')
  assert.equal(done.status, 'completed')
  const weird = mapSessionUpdate('s1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'unknown_xyz' })
  assert.equal(weird.status, 'in_progress', '未知状态应收敛为 in_progress')
})

test('mapSessionUpdate: usage_update 计算百分比', () => {
  const event = mapSessionUpdate('s1', { sessionUpdate: 'usage_update', used: 25, size: 100 })
  assert.equal(event.type, 'UsageUpdated')
  assert.equal(event.percent, 0.25)
  const zero = mapSessionUpdate('s1', { sessionUpdate: 'usage_update', used: 0, size: 0 })
  assert.equal(zero.percent, 0, 'size=0 不能除零')
})

test('mapSessionUpdate: 未知类型显式 Ignored（不静默丢弃）', () => {
  const event = mapSessionUpdate('s1', { sessionUpdate: 'brand_new_kind' })
  assert.equal(event.type, 'Ignored')
  assert.equal(event.sessionUpdate, 'brand_new_kind')
})

test('mapPermissionRequest: 提取 options 与 diff', () => {
  const event = mapPermissionRequest('s1', {
    toolCall: {
      toolCallId: 'c9',
      name: 'write',
      content: [
        { type: 'diff', path: 'a.txt', oldText: null, newText: 'hi' },
        { type: 'text', text: '忽略' },
      ],
      rawInput: { path: 'a.txt' },
    },
    options: [{ optionId: 'once' }, { optionId: 'reject' }],
  })
  assert.equal(event.type, 'PermissionRequested')
  assert.equal(event.callId, 'c9')
  assert.deepEqual(event.options, ['once', 'reject'])
  assert.equal(event.diff.length, 1, '只保留 diff 类型')
  assert.equal(event.diff[0].path, 'a.txt')
})

test('mapPromptResult: stopReason → TurnCompleted', () => {
  assert.deepEqual(mapPromptResult('s1', 'end_turn'), { type: 'TurnCompleted', sessionId: 's1', stopReason: 'end_turn' })
})

// ---------- 状态机：DomainEvent → 面板状态 ----------

test('transition: 同 messageId 增量合并为一条消息', () => {
  let state = initialPanelState
  state = transition(state, { type: 'TextDelta', sessionId: 's1', messageId: 'm1', text: '你', source: 'live' })
  state = transition(state, { type: 'TextDelta', sessionId: 's1', messageId: 'm1', text: '好', source: 'live' })
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].text, '你好')
})

test('transition: 不同 messageId 分开成两条', () => {
  let state = initialPanelState
  state = transition(state, { type: 'TextDelta', sessionId: 's1', messageId: 'm1', text: 'A', source: 'live' })
  state = transition(state, { type: 'TextDelta', sessionId: 's1', messageId: 'm2', text: 'B', source: 'live' })
  assert.equal(state.messages.length, 2)
})

test('transition: 思考与正文不合并（role 不同）', () => {
  let state = initialPanelState
  state = transition(state, { type: 'ThoughtDelta', sessionId: 's1', messageId: 'm1', text: '想', source: 'live' })
  state = transition(state, { type: 'TextDelta', sessionId: 's1', messageId: 'm1', text: '说', source: 'live' })
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0].role, 'thought')
  assert.equal(state.messages[1].role, 'assistant')
})

test('transition: 工具卡片生命周期 pending → completed', () => {
  let state = initialPanelState
  state = transition(state, { type: 'ToolCallStarted', sessionId: 's1', callId: 'c1', name: 'write', status: 'pending' })
  assert.equal(state.tools[0].status, 'pending')
  state = transition(state, { type: 'ToolCallCompleted', sessionId: 's1', callId: 'c1', name: 'write', status: 'completed' })
  assert.equal(state.tools[0].status, 'completed')
})

test('transition: PermissionRequested 挂审批并置 running', () => {
  const state = transition(initialPanelState, {
    type: 'PermissionRequested',
    sessionId: 's1',
    callId: 'c1',
    name: 'write',
    options: ['once', 'reject'],
    diff: [],
    rawInput: {},
  })
  assert.equal(state.turn, 'running')
  assert.equal(needsApproval(state).callId, 'c1')
})

test('transition: TurnCompleted 按 stopReason 收敛 turn 并清审批', () => {
  const withApproval = transition(initialPanelState, {
    type: 'PermissionRequested', sessionId: 's1', callId: 'c1', name: 'w', options: [], diff: [], rawInput: {},
  })
  const idle = transition(withApproval, { type: 'TurnCompleted', sessionId: 's1', stopReason: 'end_turn' })
  assert.equal(idle.turn, 'idle')
  assert.equal(idle.approval, undefined)

  assert.equal(transition(initialPanelState, { type: 'TurnCompleted', sessionId: 's1', stopReason: 'cancelled' }).turn, 'cancelled')
  assert.equal(transition(initialPanelState, { type: 'TurnCompleted', sessionId: 's1', stopReason: 'refusal' }).turn, 'failed')
  assert.equal(transition(initialPanelState, { type: 'TurnCompleted', sessionId: 's1', stopReason: 'error' }).turn, 'failed')
})

test('transition: 纯函数，不修改入参', () => {
  const before = JSON.stringify(initialPanelState)
  transition(initialPanelState, { type: 'TextDelta', sessionId: 's1', messageId: 'm', text: 'x', source: 'live' })
  assert.equal(JSON.stringify(initialPanelState), before, '入参被修改了')
})

test('transition: Ignored 不改变状态', () => {
  const state = transition(initialPanelState, { type: 'Ignored', sessionUpdate: 'x', reason: 'y' })
  assert.equal(state, initialPanelState, 'Ignored 应返回同一引用')
})
