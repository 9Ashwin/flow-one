import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { CN } from '../src/products.mjs'
import { login } from '../src/auth.mjs'
import { createDirectUpstream, createGatewayUpstream } from '../src/upstreams.mjs'
import { createBridgeServer } from '../src/server.mjs'
import { assertMode } from './platform.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))

function sse(frames) {
  return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

/** 解析 Anthropic SSE，返回 [{event, data}]。 */
function parseFrames(text) {
  return text.split('\n\n').filter(block => block.trim() !== '').map(block => {
    const event = /event: (.+)/.exec(block)?.[1]
    const data = JSON.parse(/data: (.+)/.exec(block)?.[1] ?? '{}')
    return { event, data }
  })
}

const baseConfig = overrides => ({
  host: '127.0.0.1', port: 0, model: '', apiKey: '', modelMap: {}, maxTokensCap: 0,
  showThinking: false, heartbeatMs: 0, ...overrides,
})

test('网关模式：Anthropic 进、OpenAI 出，Claude 模型名兜底到上游模型', async t => {
  const seen = []
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'workbuddy/deepseek-v4.1-flash' }, { id: 'kilo/free-model' }] }))
      return
    }
    if (url.pathname !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const body = await readBody(req)
    seen.push({ body, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (JSON.stringify(body.messages).includes('use-the-tool')) {
      res.end(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"/tmp/x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ]))
      return
    }
    res.end(sse([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '，我是替身模型' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 6 } },
    ]))
  })
  const upstreamUrl = await listen(upstreamServer)
  t.after(() => upstreamServer.close())

  const upstream = createGatewayUpstream({ upstream: upstreamUrl, upstreamKey: 'sk-upstream' })
  const bridge = createBridgeServer({ config: baseConfig({}), upstream, log: () => {} })
  const address = await bridge.listen()
  const base = `http://127.0.0.1:${address.port}`
  t.after(() => bridge.close())

  const headers = { 'content-type': 'application/json', 'x-api-key': 'anything' }

  const json = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 128, system: '你是助手', messages: [{ role: 'user', content: '你好' }] }),
  })
  assert.equal(json.status, 200)
  const message = await json.json()
  assert.equal(message.role, 'assistant')
  assert.equal(message.content[0].text, '你好，我是替身模型')
  assert.equal(message.stop_reason, 'end_turn')
  assert.equal(message.usage.input_tokens, 9)
  assert.equal(message.usage.output_tokens, 6)
  // 认不出的 Claude 模型名落到清单里的第一个模型，而不是把 Claude 的名字发出去
  assert.equal(message.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(seen[0].body.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(seen[0].auth, 'Bearer sk-upstream')
  assert.equal(seen[0].body.stream, true, '上游一律用流式，非流式请求由本桥归并')
  assert.equal(seen[0].body.messages[0].role, 'system')
  assert.equal(seen[0].body.messages[0].content, '你是助手')

  const streamed = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { ...headers, authorization: 'Bearer anything' },
    body: JSON.stringify({ model: 'workbuddy/deepseek-v4.1-flash', max_tokens: 128, stream: true, messages: [{ role: 'user', content: '你好' }] }),
  })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/)
  const frames = parseFrames(await streamed.text())
  assert.equal(frames[0].event, 'message_start')
  assert.equal(frames.at(-1).event, 'message_stop')
  assert.equal(frames.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data.delta.text).join(''), '你好，我是替身模型')
  assert.equal(frames.find(frame => frame.event === 'message_delta').data.delta.stop_reason, 'end_turn')
  assert.equal(frames.find(frame => frame.event === 'message_delta').data.usage.output_tokens, 6)

  const tool = parseFrames(await (await fetch(`${base}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'workbuddy/deepseek-v4.1-flash', max_tokens: 128, stream: true,
      messages: [{ role: 'user', content: 'use-the-tool' }],
      tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    }),
  })).text())
  const start = tool.find(frame => frame.event === 'content_block_start' && frame.data.content_block.type === 'tool_use')
  assert.equal(start.data.content_block.name, 'Read')
  const partial = tool.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data.delta.partial_json).join('')
  assert.deepEqual(JSON.parse(partial), { file_path: '/tmp/x' })
  assert.equal(tool.find(frame => frame.event === 'message_delta').data.delta.stop_reason, 'tool_use')
  assert.equal(seen.at(-1).body.tools[0].function.name, 'Read')

  const counted = await (await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }),
  })).json()
  assert.ok(counted.input_tokens > 100)

  const models = await (await fetch(`${base}/v1/models`, { headers })).json()
  assert.deepEqual(models.data.map(row => row.id).sort(), ['kilo/free-model', 'workbuddy/deepseek-v4.1-flash'])

  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.ok, true)
})

test('带 --api-key 时，缺密钥的请求被拒（Anthropic 错误信封）', async t => {
  const upstream = { name: 'fake', describe: () => 'fake', loadModels: async () => [], chat: async () => ({ ok: true, chunks: (async function* () {})() }) }
  const bridge = createBridgeServer({ config: baseConfig({ apiKey: 'local-key' }), upstream, log: () => {} })
  const address = await bridge.listen()
  const base = `http://127.0.0.1:${address.port}`
  t.after(() => bridge.close())

  const denied = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(denied.status, 401)
  assert.equal((await denied.json()).error.type, 'authentication_error')
  // 存活探测不需要密钥，否则「端口是否起来」都得先拿到密钥
  assert.equal((await fetch(`${base}/health`)).status, 200)
})

test('直连模式：自己登录腾讯产品，再把这条链路接到 Claude Code', async t => {
  const calls = { token: 0, chat: [] }
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/v2/plugin/auth/state') {
      send(200, { data: { state: 'st-1', authUrl: 'http://example.invalid/login?state=st-1' } })
      return
    }
    if (url.pathname === '/v2/plugin/auth/token') {
      calls.token++
      // 第一次轮询故意回「尚未就绪」，验证 11217 被当成继续等待而不是失败
      if (calls.token === 1) send(200, { code: 11217, msg: 'token not ready' })
      else send(200, { data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600, domain: '127.0.0.1', tokenType: 'Bearer' } })
      return
    }
    if (url.pathname === '/v2/plugin/login/account') {
      send(200, { data: { uid: 'u-1', nickname: '替身账号', enterpriseId: 'ent-1', type: 'personal' } })
      return
    }
    if (url.pathname === '/console/enterprises/personal/models') {
      send(200, { data: {
        agents: [{ name: 'cli', models: ['fixture-model', 'auto', 'nes-autocomplete'] }],
        models: [
          { id: 'fixture-model', name: '替身模型', maxInputTokens: 128000, maxOutputTokens: 32000, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' } },
          { id: 'extra-model', name: '另一个模型' },
          { id: 'nes-autocomplete', name: '补全' },
        ],
      } })
      return
    }
    if (url.pathname === '/v3/config') {
      send(200, { data: { models: [{ id: 'only-in-config', name: '只在 config 里' }], agents: [] } })
      return
    }
    if (url.pathname === '/v2/chat/completions') {
      const body = await readBody(req)
      calls.chat.push({ body, headers: req.headers })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([
        { choices: [{ delta: { reasoning_content: '先想一下' } }] },
        { choices: [{ delta: { content: '替身模型回答' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 21, completion_tokens: 8 } },
      ]))
      return
    }
    send(404, { msg: 'not found' })
  })
  const endpoint = await listen(upstreamServer)
  t.after(() => upstreamServer.close())

  // 用真实产品常量 + 本机端点：登录、续期、UA、报文形态全部按生产代码走。
  const product = { ...CN, id: 'cn', endpoint, apiDomain: '127.0.0.1', label: '替身产品' }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-test-'))
  const credentialFile = path.join(home, 'credentials.json')

  const credential = await login(product, { file: credentialFile, log: () => {}, openBrowser: () => {} })
  assert.equal(credential.accessToken, 'at-1')
  assert.equal(credential.account.nickname, '替身账号')
  assertMode(credentialFile, 0o600, '凭据必须是 0600')
  assert.equal(calls.token, 2, '11217 之后应当继续轮询')

  const upstream = createDirectUpstream({ products: [product], credentialFile }, { log: () => {} })
  const rows = await upstream.loadModels()
  assert.deepEqual(rows.map(row => row.id), ['cn/fixture-model', 'cn/extra-model', 'cn/only-in-config'],
    '过滤 auto / 补全模型，并合并两个端点的目录')

  const bridge = createBridgeServer({ config: baseConfig({ model: '' }), upstream, log: () => {} })
  const address = await bridge.listen()
  const base = `http://127.0.0.1:${address.port}`
  t.after(() => bridge.close())

  // Claude Code 发来的仍是它自己的模型名，桥要落到 cn/ 下的第一个模型
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 512, stream: true, system: '你是助手', messages: [{ role: 'user', content: '你好' }] }),
  })
  assert.equal(response.status, 200)
  const frames = parseFrames(await response.text())
  assert.equal(frames.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data.delta.text).join(''), '替身模型回答')
  assert.doesNotMatch(JSON.stringify(frames), /先想一下/, '思考增量默认不渲染（--thinking 才渲染）')

  const [chat] = calls.chat
  assert.equal(chat.body.model, 'fixture-model', '发给上游的模型 ID 不带产品前缀')
  assert.equal(chat.body.stream, true)
  assert.equal(chat.body.messages[0].role, 'system', '首条必须是 system')
  assert.ok(typeof chat.body.prompt_cache_key === 'string' && chat.body.prompt_cache_key.length > 0, '前缀缓存键必须下发')
  assert.equal(chat.body.max_tokens, 512)
  assert.equal(chat.headers['x-product-code'], 'codebuddy')
  assert.equal(chat.headers['x-domain'], '127.0.0.1')
  assert.equal(chat.headers['x-enterprise-id'], 'ent-1')
  assert.equal(chat.headers.authorization, 'Bearer at-1')
  assert.equal(chat.headers['x-agent-purpose'], 'conversation')
  assert.equal(chat.headers['user-agent'], product.userAgent)
})

test('直连模式：上游流内的安全策略拦截被如实报出，而不是干净收尾', async t => {
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname !== '/v2/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([{ code: 11140, msg: '内容涉嫌违规' }]))
  })
  const endpoint = await listen(upstreamServer)
  t.after(() => upstreamServer.close())

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-test-'))
  const credentialFile = path.join(home, 'credentials.json')
  fs.writeFileSync(credentialFile, JSON.stringify({
    cn: { accessToken: 'at', refreshToken: 'rt', domain: '127.0.0.1', expiresAt: Date.now() + 3_600_000 },
  }), { mode: 0o600 })

  const product = { ...CN, endpoint, apiDomain: '127.0.0.1', label: '替身产品' }
  const upstream = createDirectUpstream({ products: [product], credentialFile }, { log: () => {} })
  const bridge = createBridgeServer({ config: baseConfig({}), upstream, log: () => {} })
  const address = await bridge.listen()
  t.after(() => bridge.close())
  const base = `http://127.0.0.1:${address.port}`

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cn/whatever', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const frames = parseFrames(await response.text())
  const error = frames.find(frame => frame.event === 'error')
  assert.ok(error !== undefined, '必须出现 error 事件')
  assert.match(error.data.error.message, /内容涉嫌违规/)
  assert.equal(frames.at(-1).event, 'message_stop')
})

test('模型名带 [1m] 后缀也能命中（Claude Code 理论上会剥掉，但别把兜底浪费在这上面）', async t => {
  const seen = []
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'cn/deepseek-v4.1-flash' }] }))
      return
    }
    seen.push(await readBody(req))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
  })
  const upstreamUrl = await listen(upstreamServer)
  t.after(() => upstreamServer.close())
  const upstream = createGatewayUpstream({ upstream: upstreamUrl, upstreamKey: '' })
  const bridge = createBridgeServer({ config: baseConfig({}), upstream, log: () => {} })
  const address = await bridge.listen()
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cn/deepseek-v4.1-flash[1m]', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 200)
  assert.equal(seen[0].model, 'cn/deepseek-v4.1-flash', '后缀必须被剥掉，且走的是命中路径而不是兜底')
})

test('login 是独立命令：轮询期间进程不能自己退出（子进程回归）', async t => {
  // 用子进程而不是本进程断言：测试进程自己有句柄撑着，sleep 被 unref 也照不出来。
  // 真实缺陷（2026-10-16）：`node cli.mjs login` 打印完链接就退出，用户授权后没人取令牌。
  let tokenPolls = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = payload => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (url.pathname === '/v2/plugin/auth/state') return send({ data: { state: 'st-x', authUrl: 'http://example.invalid/login' } })
    if (url.pathname === '/v2/plugin/auth/token') {
      tokenPolls++
      return send(tokenPolls === 1 ? { code: 11217 } : { data: { accessToken: 'at-x', refreshToken: 'rt-x', expiresIn: 3600, domain: '127.0.0.1' } })
    }
    if (url.pathname === '/v2/plugin/login/account') return send({ data: { uid: 'u-x', nickname: '子进程账号', type: 'personal' } })
    send({ msg: 'not found' })
  })
  const endpoint = await listen(server)
  t.after(() => server.close())

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-child-'))
  const file = path.join(home, 'credentials.json')
  const product = { ...CN, endpoint, apiDomain: '127.0.0.1', label: '子进程产品' }
  const script = `
    const { login } = await import(${JSON.stringify(new URL('../src/auth.mjs', import.meta.url).href)})
    await login(${JSON.stringify(product)}, { file: ${JSON.stringify(file)}, log: () => {}, openBrowser: () => {} })
    process.stdout.write('LOGGED_IN')
  `
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout') }, 20_000)
    child.on('exit', status => { clearTimeout(timer); resolve(status) })
  })
  assert.equal(code, 0, `子进程应当正常退出（err: ${err}）`)
  assert.match(out, /LOGGED_IN/, '等待期间进程必须活着，否则拿不到令牌')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cn.accessToken, 'at-x')
})
