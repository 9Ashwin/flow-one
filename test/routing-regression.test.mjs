import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPENCODE } from '../src/opencode.mjs'
import { createDirectUpstream } from '../src/upstreams.mjs'
import { createBridgeServer } from '../src/server.mjs'

const config = { host: '127.0.0.1', port: 0, model: 'default', modelMap: {}, apiKey: '', heartbeatMs: 0 }

test('direct 来源别名被剥离，未挂载来源与 vendor/model 保持原样', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-routing-'))
  const previous = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(JSON.parse(options.body).model)
    return new Response('data: [DONE]\n\n')
  })
  const upstream = createDirectUpstream({ products: [OPENCODE] })
  for (const model of ['opencode/foo', 'oc/foo', 'vendor/model', 'intl/foo', 'plain']) {
    const result = await upstream.chat({ model, messages: [] })
    for await (const chunk of result.chunks) assert.fail(JSON.stringify(chunk))
  }
  assert.deepEqual(seen, ['foo', 'foo', 'vendor/model', 'intl/foo', 'plain'])
})

test('modelMap 不应把 Object 原型属性当成用户模型映射', async t => {
  const seen = []
  const upstream = { describe: () => 'test', loadModels: async () => [], chat: async body => {
    seen.push(body.model)
    return { ok: true, chunks: (async function* () { yield { choices: [{ delta: { content: 'ok' } }] } })() }
  } }
  const bridge = createBridgeServer({ config, upstream })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  for (const model of ['constructor', 'toString', '__proto__']) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.deepEqual(seen, ['default', 'default', 'default'])
})

test('客户端在模型清单等待期间断开后不能再启动上游生成', { timeout: 5000 }, async t => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const models = new Promise(resolve => { release = resolve })
  let calls = 0
  const upstream = { describe: () => 'test', loadModels: () => { entered(); return models }, chat: async () => { calls++; return { ok: false, status: 502, message: 'unexpected' } } }
  const bridge = createBridgeServer({ config, upstream })
  const address = await bridge.listen()
  t.after(() => { release([]); return bridge.close() })
  let disconnected
  const closed = new Promise(resolve => { disconnected = resolve })
  bridge.server.once('request', (req, res) => res.once('close', disconnected))
  const req = http.request({ host: '127.0.0.1', port: address.port, path: '/v1/messages', method: 'POST' })
  req.on('error', () => {})
  req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))
  await started
  req.destroy()
  await closed
  release([])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
})

test('上游 HTTP 错误保留状态；非流式流内错误立即关闭迭代器', async t => {
  let closed = false
  let readAfterError = false
  const upstream = { describe: () => 'test', loadModels: async () => [], chat: async body => {
    if (body.messages[0].content === 'rate') return { ok: false, status: 429, message: 'slow down' }
    return { ok: true, chunks: (async function* () {
      try {
        yield { error: { message: 'upstream failed' } }
        readAfterError = true
        yield { choices: [{ delta: { content: 'must not consume' } }] }
      } finally { closed = true }
    })() }
  } }
  const bridge = createBridgeServer({ config, upstream })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  for (const [content, status, type] of [['rate', 429, 'rate_limit_error'], ['error', 502, 'api_error']]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content }] }) })
    assert.equal(response.status, status)
    assert.equal((await response.json()).error.type, type)
  }
  assert.equal(closed, true)
  assert.equal(readAfterError, false)
})

test('直接使用服务 API 也不能绕过非回环鉴权校验，拒绝发生在 bind 前', async t => {
  const bind = t.mock.method(http.Server.prototype, 'listen', () => assert.fail('不允许启动公网服务'))
  for (const host of ['0.0.0.0', '::']) {
    for (const apiKey of ['', 'flow-one-local']) {
      assert.throws(() => createBridgeServer({ config: { ...config, host, apiKey }, upstream: {} }), /非回环/)
    }
  }
  const mutable = { ...config }
  const bridge = createBridgeServer({ config: mutable, upstream: {} })
  mutable.host = '0.0.0.0'
  await assert.rejects(bridge.listen(), /非回环/)
  assert.equal(bind.mock.callCount(), 0)
})
