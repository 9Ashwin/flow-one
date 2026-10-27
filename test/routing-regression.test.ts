import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Upstream, UpstreamModel } from '../src/types.ts'
import type { TestContext } from 'node:test'
import { OPENCODE } from '../src/opencode.ts'
import { createDirectUpstream } from '../src/upstreams.ts'
import { createBridgeServer } from '../src/server.ts'
import type { ChatResult } from '../src/types.ts'

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
  const seen: string[] = []
  ;(t as TestContext).mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    seen.push(JSON.parse(options?.body as string).model)
    return new Response('data: [DONE]\n\n')
  })
  const upstream = createDirectUpstream({ products: [OPENCODE] })
  for (const model of ['opencode/foo', 'oc/foo', 'vendor/model', 'intl/foo', 'plain']) {
    const result = (await upstream.chat({ model, messages: [] })) as unknown as { chunks: AsyncGenerator<unknown> }
    for await (const chunk of result.chunks) assert.fail(JSON.stringify(chunk))
  }
  assert.deepEqual(seen, ['foo', 'foo', 'vendor/model', 'intl/foo', 'plain'])
})

test('modelMap 不应把 Object 原型属性当成用户模型映射', async t => {
  const seen: string[] = []
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async (body: any) => {
      seen.push(body.model)
      return {
        ok: true,
        chunks: (async function* () {
          yield { choices: [{ delta: { content: 'ok' } }] }
        })(),
      }
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  for (const model of ['constructor', 'toString', '__proto__']) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.deepEqual(seen, ['default', 'default', 'default'])
})

test('客户端在模型清单等待期间断开后不能再启动上游生成', { timeout: 5000 }, async t => {
  let release: (value?: unknown) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const models = new Promise<UpstreamModel[]>(resolve => {
    release = value => resolve(value as UpstreamModel[])
  })
  let calls = 0
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: () => {
      entered()
      return models
    },
    chat: async () => {
      calls++
      return { ok: false, status: 502, message: 'unexpected' }
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => {
    release([])
    return bridge.close()
  })
  let disconnected: () => void = () => {}
  const closed = new Promise<void>(resolve => {
    disconnected = resolve
  })
  bridge.server.once('request', (_req, res) => res.once('close', disconnected))
  const req = http.request({ host: '127.0.0.1', port: address.port, path: '/v1/messages', method: 'POST' })
  req.on('error', () => {})
  req.end(JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'hi' }] }))
  await started
  req.destroy()
  await closed
  release([])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
})

test('默认文本请求不能被清单刷新阻塞，但图片请求仍等待模型能力', { timeout: 5000 }, async t => {
  let release: (rows: UpstreamModel[]) => void = () => {}
  const catalogue = new Promise<UpstreamModel[]>(resolve => {
    release = resolve
  })
  let calls = 0
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: () => catalogue,
    chat: async () => {
      calls++
      return {
        ok: true,
        chunks: (async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
        })(),
      }
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = await bridge.listen()
  t.after(() => {
    release([])
    return bridge.close()
  })
  const send = (content: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content }] }),
    })
  const text = await Promise.race([
    send('hi'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('catalogue blocked text')), 500)),
  ])
  assert.equal(text.status, 200)
  await text.text()
  const image = send([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }])
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls, 1, '图片需要等到模型能力已知')
  release([{ id: 'default', supportsImages: false }])
  const unsupported = await image
  assert.equal(unsupported.status, 400)
  assert.match(await unsupported.text(), /does not support image input/)
  assert.equal(calls, 1)
})

test('腾讯模型冷启动仍等待元数据，不能丢失输出上限和推理档位', { timeout: 5000 }, async t => {
  let release: (rows: UpstreamModel[]) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const catalogue = new Promise<UpstreamModel[]>(resolve => {
    release = resolve
  })
  let calls = 0
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: () => {
      entered()
      return catalogue
    },
    chat: async () => {
      calls++
      return {
        ok: true,
        chunks: (async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
        })(),
      }
    },
  }
  const bridge = createBridgeServer({ config: { ...config, model: 'intl/example' }, upstream })
  const address = await bridge.listen()
  t.after(() => {
    release([])
    return bridge.close()
  })
  const response = fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
  })
  await started
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls, 0)
  release([{ id: 'intl/example', maxOutputTokens: 4096, efforts: ['low'] }])
  assert.equal((await response).status, 200)
  assert.equal(calls, 1)
})

test('上游 HTTP 错误保留状态；非流式流内错误立即关闭迭代器', async t => {
  let closed = false
  let readAfterError = false
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async (body: any) => {
      if (body.messages[0].content === 'rate') return { ok: false, status: 429, message: 'slow down' }
      return {
        ok: true,
        chunks: (async function* () {
          try {
            yield { error: { message: 'upstream failed' } }
            readAfterError = true
            yield { choices: [{ delta: { content: 'must not consume' } }] }
          } finally {
            closed = true
          }
        })(),
      }
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  for (const [content, status, type] of [
    ['rate', 429, 'rate_limit_error'],
    ['error', 502, 'api_error'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    })
    assert.equal(response.status, status)
    assert.equal(((await response.json()) as { error: { type: string } }).error.type, type)
  }
  assert.equal(closed, true)
  assert.equal(readAfterError, false)
})

test('直接使用服务 API 也不能绕过非回环鉴权校验，拒绝发生在 bind 前', async t => {
  const bind = (t as TestContext).mock.method(http.Server.prototype, 'listen', () => assert.fail('不允许启动公网服务'))
  for (const host of ['0.0.0.0', '::']) {
    for (const apiKey of ['', 'flow-one-local']) {
      assert.throws(
        () => createBridgeServer({ config: { ...config, host, apiKey }, upstream: {} as unknown as Upstream }),
        /non-loopback/,
      )
    }
  }
  const mutable = { ...config }
  const bridge = createBridgeServer({ config: mutable, upstream: {} as unknown as Upstream })
  mutable.host = '0.0.0.0'
  await assert.rejects(bridge.listen(), /non-loopback/)
  assert.equal(bind.mock.callCount(), 0)
})

test('上游限流或网络异常不应自动重发，限流等待时间必须透传', async t => {
  const attempts: string[] = []
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async (body: any) => {
      attempts.push(body.messages[0].content)
      if (body.messages[0].content === 'flaky' && attempts.filter(item => item === 'flaky').length === 1) {
        return { ok: false, status: 429, message: 'slow down', retryAfter: '30' }
      }
      if (body.messages[0].content === 'bad') return { ok: false, status: 400, message: 'bad request' }
      if (body.messages[0].content === 'network') throw new Error('connection reset after request')
      return {
        ok: true,
        chunks: (async function* () {
          yield { choices: [{ delta: { content: 'ok' } }] }
        })(),
      }
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  const call = (content: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    })

  const limited = await call('flaky')
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '30')
  assert.equal(attempts.filter(item => item === 'flaky').length, 1)

  const rejected = await call('bad')
  assert.equal(rejected.status, 400, '400 不该重试，直接透传')
  assert.equal(attempts.filter(item => item === 'bad').length, 1)
  const network = await call('network')
  assert.equal(network.status, 502)
  assert.equal(attempts.filter(item => item === 'network').length, 1)
})

test('流式响应在首个上游分片之前就发出 message_start', { timeout: 5000 }, async t => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async () => ({
      ok: true,
      chunks: (async function* () {
        await gate
        yield { choices: [{ delta: { content: 'ok' } }] }
      })(),
    }),
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => {
    release()
    return bridge.close()
  })

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  // 上游还卡着，客户端必须已经看到握手 —— 否则推理模型的每一轮都在「连接中」。
  const first = await reader.read()
  assert.match(decoder.decode(first.value as Uint8Array), /event: message_start/)
  release()
  await reader.cancel()
})

test('上游静默超过 upstreamIdleMs 时以流内 error 事件收尾，而不是无限期挂着', { timeout: 5000 }, async t => {
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async () => ({
      ok: true,
      chunks: (async function* () {
        yield { choices: [{ delta: { content: '开' } }] }
        await new Promise(() => {}) // 上游连着但永远不再吐字节
      })(),
    }),
  }
  const bridge = createBridgeServer({ config: { ...config, upstreamIdleMs: 50 }, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  const text = await (
    await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
  ).text()
  assert.match(text, /event: error/)
  assert.match(text, /produced no output/)
  assert.match(text, /event: message_stop/)
})

test('客户端读取缓慢时等待背压不能触发上游空闲超时', { timeout: 10000 }, async t => {
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async () => ({
      ok: true,
      chunks: (async function* () {
        yield { choices: [{ delta: { content: 'x'.repeat(16 * 1024 * 1024) } }] }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      })(),
    }),
  }
  const bridge = createBridgeServer({ config: { ...config, upstreamIdleMs: 100, heartbeatMs: 10 }, upstream })
  let blocked = false
  let pingsWhileBlocked = 0
  bridge.server.on('request', (_req, res) => {
    const original = res.write.bind(res)
    res.write = ((...args: Parameters<typeof res.write>) => {
      if (res.writableNeedDrain && typeof args[0] === 'string' && args[0].startsWith('event: ping')) pingsWhileBlocked++
      const result = Reflect.apply(original, res, args) as boolean
      if (!result) blocked = true
      return result
    }) as typeof res.write
  })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  const result = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, path: '/v1/messages', method: 'POST' }, res => {
      let output = ''
      res.pause()
      setTimeout(() => res.resume(), 350)
      res.setEncoding('utf8')
      res.on('data', chunk => {
        output += chunk
      })
      res.on('end', () => resolve(output))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }))
  })
  assert.match(result, /event: message_stop/)
  assert.doesNotMatch(result, /event: error/)
  assert.equal(blocked, true, '必须实际触发背压')
  assert.equal(pingsWhileBlocked, 0, '背压期间不能持续写入心跳')
})

test('非流式和上游握手静默时返回 504，不能无限等待', { timeout: 5000 }, async t => {
  for (const phase of ['handshake', 'body']) {
    const upstream: Upstream = {
      describe: () => 'test',
      loadModels: async () => [],
      chat: async () =>
        phase === 'handshake'
          ? await new Promise<ChatResult>(() => {})
          : {
              ok: true,
              chunks: (async function* () {
                await new Promise(() => {})
                yield {}
              })(),
            },
    }
    const bridge = createBridgeServer({ config: { ...config, upstreamIdleMs: 30 }, upstream })
    const address = await bridge.listen()
    t.after(() => bridge.close())
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 504, phase)
    assert.match(await response.text(), /timeout/)
  }
})

test('失败时先报哪条来源出错，而不是只留最后一条', async t => {
  // 多条来源时，光一个 401 说明不了是哪条线断了。
  const upstream = {
    name: 'direct',
    describe: () => 'test',
    loadModels: async () => [],
    chat: async (): Promise<ChatResult> => ({
      ok: false,
      status: 401,
      message: 'cn: login expired',
      attempts: [{ upstream: 'cn', status: 401, message: 'login expired' }],
    }),
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 401)
  const body = (await response.json()) as { error: { message: string }; request_id?: string }
  assert.equal(body.error.message, 'cn 401: login expired', '失败摘要要点名出错的那条来源')
  assert.ok(body.request_id, '错误信封要带 request_id，日志里才有同一个 id')
})

test('日志带 request_id 与 ttft：换模型后能不能更快，要靠这两个数说话', async t => {
  const lines: string[] = []
  const upstream = {
    name: 'test',
    describe: () => 'test',
    loadModels: async () => [],
    chat: async (): Promise<ChatResult> => ({
      ok: true,
      chunks: (async function* () {
        yield { choices: [{ delta: { role: 'assistant' } }] }
        await new Promise(resolve => setTimeout(resolve, 30))
        yield { choices: [{ delta: { content: 'ok' } }] }
      })(),
    }),
  }
  const bridge = createBridgeServer({ config, upstream, log: line => lines.push(line) })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  await response.text()
  const line = lines.find(item => item.includes('stream=1'))
  assert.ok(line !== undefined, '应该有 stream=1 的日志行')
  assert.match(line, /^req_[0-9a-f]{16} /, '每行日志以 request id 开头')
  const firstChunk = Number(/first_chunk_ms=(\d+)/.exec(line)?.[1])
  const ttft = Number(/ttft=(\d+)/.exec(line)?.[1])
  assert.ok(Number.isFinite(firstChunk) && ttft - firstChunk >= 20, '元数据分片不能被算作首个可见输出')
})
