/**
 * 验证分发包：从干净安装的 node_modules 加载插件，确认
 *  1. index.js 的 MODULE_FILES 含 opencode.js
 *  2. host/opencode.js 能注册路由
 *  3. client.js 含后端切换与审批帧
 *
 * 用法：node verify-tarball.mjs <插件安装目录>
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = process.argv[2]
assert.ok(dir, '用法: node verify-tarball.mjs <插件目录>')
const abs = dir.replace(/\\/g, '/')

// 1. index.js 声明了 opencode.js
const indexSrc = readFileSync(join(dir, 'index.js'), 'utf-8')
assert.ok(indexSrc.includes("'opencode.js'"), 'index.js MODULE_FILES 缺 opencode.js')

// 2. host 模块齐全
for (const f of ['host/opencode.js', 'host/opencode-bridge.js', 'client.js', 'docs/CODEBUDDY-FUSION.md']) {
  assert.ok(existsSync(join(dir, f)), `缺文件: ${f}`)
}

// 3. 加载 host/opencode.js 并注册
const { register } = await import(pathToFileURL(`${abs}/host/opencode.js`).href)
const methods = new Map()
const streams = new Map()
register({ method: (n, f) => methods.set(n, f), stream: (n, f) => streams.set(n, f) }, { ctx: {} })
assert.ok(methods.has('opencode.info'), 'opencode.info 未注册')
assert.ok(methods.has('opencode.permission'), 'opencode.permission 未注册')
assert.ok(streams.has('opencode.stream'), 'opencode.stream 未注册')

// 4. client.js 含关键字符串
const clientSrc = readFileSync(join(dir, 'client.js'), 'utf-8')
for (const needle of ['opencode.stream', 'permission_request', 'gufa-code:backend']) {
  assert.ok(clientSrc.includes(needle), `client.js 缺 ${needle}`)
}

// 5. 本机配置不应入包
assert.equal(existsSync(join(dir, '.codebuddy-opencode.json')), false, '本机配置不应入包')

console.log('✓ 分发包完整可用：3 个端点注册 + client 关键逻辑 + 无本机配置')
