/**
 * 最小 Agent 面板状态机（纯 transition）。
 *
 * 输入：DomainEvent（反腐层输出，外壳唯一消费的契约）
 * 输出：面板视图状态（消息流 / 工具卡片 / 审批 / token 用量 / turn 状态）
 *
 * 一个 union + 一个纯 transition + driver 在 UI 层调用，没有副作用。
 *
 * 移植自 opencode-full/packages/codebuddy-adapter/src/agent-panel-machine.ts（TS → ESM JS）。
 */

export const initialPanelState = Object.freeze({
  messages: [],
  tools: [],
  approval: undefined,
  usage: { used: 0, size: 0, percent: 0 },
  turn: 'idle',
  mode: 'build',
})

/** 纯 transition：一条事件 → 新状态。不修改入参。 */
export function transition(state, event) {
  if (event === null || typeof event !== 'object') return state
  switch (event.type) {
    case 'PromptSent':
      return { ...state, turn: 'running', approval: undefined }

    case 'TextDelta':
    case 'ThoughtDelta': {
      const role = event.type === 'ThoughtDelta' ? 'thought' : 'assistant'
      const last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : undefined
      // 同一 messageId 的增量追加到最后一条，避免逐字生成上千条消息。
      if (last !== undefined && last.messageId === event.messageId && last.role === role) {
        return {
          ...state,
          messages: [...state.messages.slice(0, -1), { ...last, text: last.text + event.text }],
        }
      }
      return {
        ...state,
        messages: [...state.messages, { messageId: event.messageId, role, text: event.text, source: event.source }],
      }
    }

    case 'ToolCallStarted':
      return {
        ...state,
        tools: [...state.tools, { callId: event.callId, name: event.name, status: 'pending' }],
      }

    case 'ToolCallCompleted':
      return {
        ...state,
        tools: state.tools.map((tool) => (
          tool.callId === event.callId ? { ...tool, name: event.name, status: event.status } : tool
        )),
      }

    case 'PermissionRequested':
      return {
        ...state,
        turn: 'running',
        approval: { callId: event.callId, name: event.name, options: event.options, diff: event.diff },
      }

    case 'UsageUpdated':
      return { ...state, usage: { used: event.used, size: event.size, percent: event.percent } }

    case 'TurnCompleted': {
      const turn = event.stopReason === 'cancelled'
        ? 'cancelled'
        : event.stopReason === 'refusal' || event.stopReason === 'error' ? 'failed' : 'idle'
      return { ...state, turn, approval: undefined }
    }

    case 'ModeChanged':
      return { ...state, mode: event.mode }

    case 'Ignored':
    default:
      return state
  }
}

/** 从状态派生出 UI 是否显示审批横幅。selector 不嵌入逻辑分支之外。 */
export function needsApproval(state) {
  return state.approval
}
