/**
 * 用本地 mock 上游验证整条链路（不依赖 OpenRouter 配额/地区）。
 *
 * 覆盖：桥接模块 → ACP 子进程 → 上游 HTTP → 流式帧 → 我们的 SSE 帧契约。
 * 上游用 scripts/mock-openai-server.mjs 提供的 OpenAI 兼容端点。
 *
 * 用法：node scripts/verify-with-mock.mjs [mockPort]
 * 前置：node scripts/mock-openai-server.mjs 18080
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runOpencodePrompt, findOpencodeBin } from '../host/opencode-bridge.js'

const mockPort = process.argv[2] ?? '18080'

const found = findOpencodeBin({})
assert.ok(found !== null, '需要 opencode CLI（OPENCODE_BIN 或 .codebuddy-opencode.json）')
console.log('CLI:', found.bin, found.prefixArgs)

const workspace = join(tmpdir(), `gufa-mock-${Date.now()}`)
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  model: 'mockprovider/mock-model',
  providers: {
    mockprovider: {
      name: 'Mock Provider',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
      models: { 'mock-model': { name: 'Mock Model' } },
    },
  },
}, null, 2))

const frames = []
try {
  const result = await runOpencodePrompt({
    bin: found.bin,
    prefixArgs: found.prefixArgs,
    cwd: workspace,
    prompt: '随便说点什么。',
    onFrame: (f) => frames.push(f),
  })
  console.log('frames:', JSON.stringify(frames.slice(0, 6)), 'total=', frames.length)
  console.log('stopReason:', result.stopReason)

  const text = frames.filter((f) => f.type === 'delta').map((f) => f.text).join('')
  const errors = frames.filter((f) => f.type === 'error')

  if (errors.length > 0) {
    console.log('⚠ 上游错误帧:', JSON.stringify(errors[0]))
    console.log('（mock 未生效或 opencode 未采用该 provider 配置）')
    process.exitCode = 1
  } else {
    assert.ok(text.includes('你好呀'), `期望收到 mock 回复，实际: ${JSON.stringify(text)}`)
    assert.equal(frames.at(-1).type, 'done', '最后一帧应为 done')
    console.log('✓ 全链路通过：桥 → ACP → mock 上游 → 流式帧 → done')
  }
} finally {
  // Windows 上 opencode 子进程可能仍持有句柄，清理失败不影响验证结论。
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
