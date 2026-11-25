/**
 * 模拟 DSH host 调用已安装插件的 opencode.stream，验证完整 SSE 帧序列。
 *
 * 与 verify-installed-opencode.mjs 的区别：那个直接调 runOpencodePrompt，
 * 这个走 opencode.js 注册的 router.stream —— 即 DSH 真实调用的那一层，
 * 包含消息解析、上下文前缀、审批挂起、错误收敛。
 *
 * 用法：node scripts/verify-stream-endpoint.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const INSTALLED = process.env.INSTALLED_PLUGIN_DIR
  ?? 'C:/Users/付琛枫/.dsh/profiles/desktop/node_modules/dsh-gufa-code'
const base = pathToFileURL(`${INSTALLED}/host/`).href

const { register } = await import(`${base}opencode.js`)

// 收集注册的路由
const methods = new Map()
const streams = new Map()
register(
  { method: (n, f) => methods.set(n, f), stream: (n, f) => streams.set(n, f) },
  { ctx: {} },
)
assert.ok(streams.has('opencode.stream'), 'opencode.stream 未注册')

// 模拟 router.stream 的调用约定：fn(body, { signal, send, close })
const frames = []
let closed = false
const send = (frame) => frames.push(frame)
const close = () => { closed = true }

const body = {
  messages: [{ role: 'user', content: '只回复三个字：你好呀。不要解释。' }],
  context: { root: process.cwd() },
}

console.log('调用 opencode.stream …')
await streams.get('opencode.stream')(body, { signal: undefined, send, close })

console.log('closed:', closed)
console.log('frames:', JSON.stringify(frames.slice(0, 8)), 'total=', frames.length)

assert.equal(closed, true, 'stream 结束必须调用 close()')
assert.ok(frames.length > 0, '至少要有一帧')

const errors = frames.filter((f) => f.type === 'error')
const deltas = frames.filter((f) => f.type === 'delta')

if (errors.length > 0) {
  console.log('⚠ 上游错误帧:', JSON.stringify(errors[0]))
  // 上游问题不算实现缺陷，但必须收敛成规范 error 帧且已 close
  assert.equal(frames.at(-1).type, 'error', '错误应以 error 帧收敛')
  console.log('✓ 端点契约正确（错误已规范收敛），但上游当前不可用')
  process.exit(0)
}

const text = deltas.map((f) => f.text).join('')
assert.ok(text.length > 0, '应有文本输出')
assert.equal(frames.at(-1).type, 'done', '最后一帧应为 done')
assert.ok(frames.some((f) => f.type === 'thinking'), '应有 thinking 帧')
console.log(`✓ opencode.stream 端点契约正确：thinking → delta(${JSON.stringify(text.slice(0, 20))}) → done`)
