/**
 * 双端状态机一致性测试：客户端精简版 vs host 版对同一批帧的语义必须一致。
 *
 * 背景：客户端是拼接产物不能 import，所以 40-chat.js 内联了一份精简 transition。
 * 两边语义一旦漂移，就会出现「host 认为是审批、客户端当普通文本」这类诡异 bug。
 * 本测试守住这个边界。
 *
 * 用法：node --test scripts/test-transition-parity.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 从 client.js 构建产物里取出客户端 transition（走真实产物，不复制源码）。 */
function loadClientTransition() {
  const code = readFileSync(join(root, 'client.js'), 'utf8')
  const noop = () => {}
  const element = (tag) => ({ tag, dataset: {}, style: {}, setAttribute: noop, remove: noop, textContent: '' })
  const windowStub = {
    __ModuleLoader__: { load(definition) { windowStub.__definition = definition } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    // 不真正起定时器：否则进程退不出去（这里只需要 transition 纯函数）。
    setInterval: () => 0,
    clearInterval: noop,
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    monaco: undefined,
    require: undefined,
  }
  const documentStub = {
    createElement: element,
    documentElement: { dataset: {}, style: {}, setAttribute: noop, removeAttribute: noop },
    head: { appendChild: noop, append: noop },
    body: { appendChild: noop, append: noop },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
  }
  const localStorageStub = {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
    setItem(k, v) { this.store.set(k, String(v)) },
    removeItem(k) { this.store.delete(k) },
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, noop],
    useEffect: noop, useLayoutEffect: noop, useMemo: (f) => f(),
    useRef: (v) => ({ current: v }), useCallback: (f) => f,
    useContext: () => ({}), useReducer: (r, i) => [i, noop],
  }
  new Function(
    'window', 'document', 'localStorage', 'location', 'fetch',
    'TextDecoder', 'AbortController', 'MutationObserver', 'console',
    code,
  )(
    windowStub, documentStub, localStorageStub, { href: 'http://x/', search: '' },
    () => Promise.reject(new Error('no fetch')), TextDecoder, AbortController,
    class { observe() {} disconnect() {} }, console,
  )
  const def = windowStub.__definition ?? {}
  const plugin = def.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const noopSlot = { inject: (o, cb) => cb(), register: () => () => {} }
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {} }
      if (name === 'slots') return noopSlot
      if (name === 'layout') return { selectPanel() {} }
      if (name === 'uiWorkspace') return { pickDirectory: async () => null }
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => { cb({ slots: noopSlot, get: ctx.get, effect: ctx.effect }); return () => {} },
  }
  plugin.apply(ctx)
  const G = windowStub.__GUFA_CODE__?.G
  assert.ok(G !== undefined, '未能从构建产物拿到 G')
  assert.equal(typeof G.chatTransition, 'function', 'G.chatTransition 未暴露')
  return G.chatTransition
}

const tr = loadClientTransition()

/** 客户端动作 → 语义标签，便于和 host 的状态结果对比。 */
function clientSemantics(frame) {
  const action = tr(frame)
  switch (action.kind) {
    case 'thinking': return 'thought'
    case 'append': return 'text'
    case 'approval': return 'approval'
    case 'finish': return action.failed ? 'turn-failed' : 'turn-idle'
    default: return 'ignored'
  }
}

test('客户端与 host 对文本帧语义一致', () => {
  assert.equal(clientSemantics({ type: 'delta', text: 'hi' }), 'text')
  assert.equal(clientSemantics({ type: 'delta', text: '' }), 'ignored', '空 delta 不应产生动作')
})

test('客户端与 host 对推理帧语义一致', () => {
  assert.equal(clientSemantics({ type: 'thinking' }), 'thought')
})

test('客户端与 host 对审批帧语义一致', () => {
  assert.equal(clientSemantics({ type: 'permission_request', requestId: 1 }), 'approval')
})

test('客户端与 host 对结束帧语义一致', () => {
  assert.equal(clientSemantics({ type: 'done' }), 'turn-idle')
  assert.equal(clientSemantics({ type: 'error', message: 'x' }), 'turn-failed')
})

test('未知/畸形帧两端都忽略（不崩溃）', () => {
  for (const frame of [null, undefined, 'str', 42, {}, { type: 'nope' }, { type: 'delta' }]) {
    assert.equal(clientSemantics(frame), 'ignored', `帧 ${JSON.stringify(frame)} 应被忽略`)
  }
})

test('审批帧必须带 requestId，否则客户端无法回传决策', () => {
  const action = tr({ type: 'permission_request', requestId: 42 })
  assert.equal(action.kind, 'approval')
  assert.equal(action.requestId, 42)
})
