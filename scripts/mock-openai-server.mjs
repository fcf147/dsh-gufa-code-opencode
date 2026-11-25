#!/usr/bin/env node
/**
 * 本地 mock OpenAI 兼容服务：用于在没有真实上游（配额/地区限制）时验证整条链路。
 *
 * 提供 /v1/models 与 /v1/chat/completions（支持 stream），
 * 返回固定内容，让 opencode → ACP → 我们的桥 → SSE 帧 全链路可验证。
 *
 * 用法：node scripts/mock-openai-server.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18080)
const REPLY = '你好呀'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = createServer((req, res) => {
  const url = req.url ?? '/'

  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
    })
    return
  }

  if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
    let raw = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 忽略 */ }
      const streaming = body.stream === true

      if (!streaming) {
        sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' }
      // 逐字发送，模拟真实流式
      for (const ch of REPLY) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }

  sendJson(res, 404, { error: { message: `mock: unhandled ${req.method} ${url}`, code: 404 } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-openai listening on http://127.0.0.1:${port}`)
})
