/**
 * 验证「已安装插件目录」中的 opencode 后端：
 *  1. findOpencodeBin 能读到 .codebuddy-opencode.json
 *  2. opencode.info / opencode.stream 能注册
 *  3. opencode.stream 真跑一次 prompt（需要配置指向可用 CLI）
 *
 * 从已装插件路径加载：node scripts/verify-installed-opencode.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const INSTALLED = process.env.INSTALLED_PLUGIN_DIR
  ?? 'C:/Users/付琛枫/.dsh/profiles/desktop/node_modules/dsh-gufa-code'
const base = pathToFileURL(`${INSTALLED}/host/`).href
const { findOpencodeBin, runOpencodePrompt } = await import(`${base}opencode-bridge.js`)
const { register } = await import(`${base}opencode.js`)

const found = findOpencodeBin({})
console.log('findOpencodeBin:', JSON.stringify(found))
assert.ok(found !== null, '已装插件应探测到 opencode 配置')

const methods = new Map()
const streams = new Map()
register({ method: (n, f) => methods.set(n, f), stream: (n, f) => streams.set(n, f) }, { ctx: {} })
assert.ok(methods.has('opencode.info'), 'opencode.info 未注册')
assert.ok(streams.has('opencode.stream'), 'opencode.stream 未注册')

const info = await methods.get('opencode.info')({})
console.log('opencode.info:', JSON.stringify(info))
assert.equal(info.ready, true)

const frames = []
const result = await runOpencodePrompt({
  bin: found.bin,
  prefixArgs: found.prefixArgs,
  cwd: process.cwd(),
  prompt: '只回复三个字：你好呀。不要解释。',
  onFrame: (f) => frames.push(f),
})
console.log('frames:', JSON.stringify(frames.slice(0, 5)), 'total=', frames.length, 'stop=', result.stopReason)
assert.ok(frames.some((f) => f.type === 'delta' && f.text.includes('你好呀')))
assert.equal(frames.at(-1).type, 'done')
console.log('✓ 已装插件的 opencode 后端端到端可用')
