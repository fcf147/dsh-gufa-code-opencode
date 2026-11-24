/**
 * 反腐层：ACP 原生 session/update → 外壳自研 DomainEvent。
 *
 * 硬约束：外壳（Agent 面板 / IDE）只消费 DomainEvent，禁止直接消费 ACP 原生类型。
 * OpenCode 契约演进时只改本文件的映射，外壳状态机不动。
 *
 * 映射依据：@agentclientprotocol/sdk@1.6.0 的 sessionUpdate 变体
 * 与 A2–A6 Spike 实测帧（codebuddy/spike/*.ndjson）。
 *
 * 三层决策值不要混用：
 *   effect(allow/deny/ask) / reply(once/always/reject) / ACP optionId(once/always/reject)
 *
 * 移植自 opencode-full/packages/codebuddy-adapter/src/domain-event.ts（TS → ESM JS）。
 */

/** live = 实时流；replay = session/load 的历史回放。UI 需区分二者。 */
export const EventSource = Object.freeze({ live: 'live', replay: 'replay' })

function textOf(update) {
  const content = update.content
  return {
    messageId: String(update.messageId ?? ''),
    text: content !== null && typeof content === 'object' && typeof content.text === 'string' ? content.text : '',
  }
}

function toolIdentity(update) {
  return { callId: String(update.toolCallId ?? ''), name: String(update.title ?? update.name ?? '') }
}

/** 核心映射：一条 ACP session/update → 一条 DomainEvent。 */
export function mapSessionUpdate(sessionId, update, source = 'live') {
  const kind = update !== null && typeof update === 'object' ? update.sessionUpdate : ''
  switch (kind) {
    case 'agent_message_chunk': {
      const { messageId, text } = textOf(update)
      return { type: 'TextDelta', sessionId, messageId, text, source }
    }
    case 'agent_thought_chunk': {
      const { messageId, text } = textOf(update)
      return { type: 'ThoughtDelta', sessionId, messageId, text, source }
    }
    case 'user_message_chunk':
      // 用户消息回放属历史，映射为 TextDelta 但标记来源，UI 可区别渲染。
      return { type: 'TextDelta', sessionId, ...textOf(update), source: 'replay' }
    case 'tool_call': {
      const { callId, name } = toolIdentity(update)
      return { type: 'ToolCallStarted', sessionId, callId, name, status: 'pending' }
    }
    case 'tool_call_update': {
      const { callId, name } = toolIdentity(update)
      const rawStatus = String(update.status ?? '')
      const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'in_progress'
        ? rawStatus
        : 'in_progress'
      return { type: 'ToolCallCompleted', sessionId, callId, name, status }
    }
    case 'usage_update': {
      const used = Number(update.used ?? 0)
      const size = Number(update.size ?? 0)
      return { type: 'UsageUpdated', sessionId, used, size, percent: size > 0 ? used / size : 0 }
    }
    case 'current_mode_update':
      return { type: 'ModeChanged', sessionId, mode: String(update.mode ?? '') }
    default:
      // 不静默丢弃：未知类型显式记录，便于契约漂移时被测试发现。
      return { type: 'Ignored', sessionUpdate: kind, reason: 'no domain mapping' }
  }
}

/** 审批请求映射：ACP session/request_permission 的 params → PermissionRequested。 */
export function mapPermissionRequest(sessionId, params) {
  const toolCall = params !== null && typeof params === 'object' && params.toolCall !== null && typeof params.toolCall === 'object'
    ? params.toolCall
    : {}
  const callId = String(toolCall.toolCallId ?? '')
  const name = String(toolCall.name ?? '')
  const rawOptions = Array.isArray(params?.options) ? params.options : []
  const options = rawOptions.map((o) => String(o?.optionId ?? ''))
  const content = Array.isArray(toolCall.content) ? toolCall.content : []
  const diff = content.filter((c) => c !== null && typeof c === 'object' && c.type === 'diff')
  return {
    type: 'PermissionRequested',
    sessionId,
    callId,
    name,
    options,
    diff,
    rawInput: toolCall.rawInput !== null && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {},
  }
}

/** prompt 返回 → TurnCompleted。 */
export function mapPromptResult(sessionId, stopReason) {
  return { type: 'TurnCompleted', sessionId, stopReason }
}
