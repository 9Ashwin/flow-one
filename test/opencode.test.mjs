import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

/** 隔离的 BRIDGE_HOME：项目 id 会落到那里，不碰真实家目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-oc-'))
  process.env.BRIDGE_HOME = dir
  return dir
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('门禁形状：会话 / 请求 id 的位数与字符集必须是官方那一套', async () => {
  scratch()
  const { sessionId, requestId, projectId } = await import('../src/opencode.mjs')
  // 尾段总长 26 = 12 hex + 14 base62；误做成「随机 26 位」会得到 38 字符而被 403
  for (let i = 0; i < 50; i++) {
    assert.match(sessionId(), SESSION_PATTERN)
    assert.match(requestId(), REQUEST_PATTERN)
  }
  assert.equal(sessionId().length, 4 + 26)
  assert.match(projectId(), /^[0-9a-f]{40}$/)
  assert.equal(projectId(), projectId(), '项目 id 必须落盘复用，每次换一个会被看成新客户端')
})

test('门禁形状：出站工具名统一小写、缺的四个补齐、stream 强制为 true', async () => {
  scratch()
  const { applyFreeTierGate, GATE_TOOLS } = await import('../src/opencode.mjs')
  const gated = applyFreeTierGate({
    stream: false,
    tools: [
      { type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
      { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      { type: 'function', function: { name: 'Edit', parameters: { type: 'object' } } },
    ],
  })
  assert.equal(gated.body.stream, true, '门禁要求 stream: true')
  const names = gated.body.tools.map(tool => tool.function.name)
  for (const gate of GATE_TOOLS) assert.ok(names.includes(gate), `缺少门禁工具 ${gate}`)
  assert.equal(names.filter(name => name === 'bash').length, 1, '不能重复补桩')
  assert.equal(names.filter(name => name === 'Edit').length, 1, '非门禁工具原样保留（大小写也不动）')
  // 调用方自己声明过的：出站小写、响应要改回原名
  assert.equal(gated.rename.get('bash'), 'Bash')
  assert.equal(gated.rename.get('read'), 'Read')
  // 调用方没声明的：桩，响应里要丢弃
  assert.deepEqual([...gated.stubs].sort(), ['glob', 'grep'])
  for (const name of ['glob', 'grep']) {
    const tool = gated.body.tools.find(item => item.function.name === name)
    assert.ok(Object.keys(tool.function.parameters.properties).length > 0, '桩工具至少要声明一个 property')
  }
})

test('响应侧：改回调用方原名，桩工具的调用整条丢弃', async () => {
  scratch()
  const { restoreToolCalls } = await import('../src/opencode.mjs')
  const rename = new Map([['bash', 'Bash']])
  const stubs = new Set(['glob'])
  async function* source() {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash', arguments: '{"command":' } }] } }] }
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }
    yield { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] } }] }
    yield { choices: [{ delta: { content: '完成' } }] }
  }
  const out = []
  for await (const chunk of restoreToolCalls(source(), { rename, stubs })) out.push(chunk)
  const names = out.flatMap(chunk => (chunk.choices ?? []).flatMap(choice => (choice.delta?.tool_calls ?? []).map(call => call.function?.name).filter(Boolean)))
  assert.deepEqual(names, ['Bash'], 'bash 还原成 Bash；glob 是桩，整条丢弃')
  // 参数分片要原样跟着走，不能被改名逻辑吃掉
  const args = out.flatMap(chunk => (chunk.choices ?? []).flatMap(choice => (choice.delta?.tool_calls ?? []).map(call => call.function?.arguments).filter(Boolean))).join('')
  assert.equal(args, '{"command":"ls"}')
})

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

const sse = frames => `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`

function parseFrames(text) {
  return text.split('\n\n').filter(block => block.trim() !== '').map(block => ({
    event: /event: (.+)/.exec(block)?.[1],
    data: JSON.parse(/data: ([\s\S]+)/.exec(block)?.[1] ?? '{}'),
  }))
}

test('端到端：Claude Code 的请求经桥 → OpenCode 免费档，工具名来回都对得上', async t => {
  scratch()
  const seen = []
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash-free' }, { id: 'deepseek-v4.1-flash' }] }))
      return
    }
    const body = await readBody(req)
    seen.push({ body, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const { OPENCODE } = await import('../src/opencode.mjs')
  const { createDirectUpstream } = await import('../src/upstreams.mjs')
  const { createBridgeServer } = await import('../src/server.mjs')
  const source = { ...OPENCODE, baseUrl: `http://127.0.0.1:${upstream.address().port}` }
  const model = 'oc/deepseek-v4.1-flash-free'
  const bridge = createBridgeServer({
    config: { host: '127.0.0.1', port: 0, model, apiKey: '', modelMap: {}, maxTokensCap: 0, showThinking: false, heartbeatMs: 0, fingerprintRewrite: true },
    upstream: createDirectUpstream({ products: [source], credentialFile: path.join(scratch(), 'none.json') }, { log: () => {} }),
    log: () => {},
  })
  const address = await bridge.listen()
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 128, stream: true,
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: '列出当前目录' }],
      tools: [{ name: 'Bash', description: '执行命令', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    }),
  })
  assert.equal(response.status, 200)
  const frames = parseFrames(await response.text())

  // 出站报文必须是门禁形状
  const [request] = seen
  assert.match(request.headers['x-opencode-project'], /^[0-9a-f]{40}$/)
  assert.equal(request.headers['x-opencode-session'], request.headers['x-opencode-session-id'], '别名头必须与 session 一致')
  assert.match(request.headers['x-opencode-session'], SESSION_PATTERN)
  assert.match(request.headers['x-opencode-request'], REQUEST_PATTERN)
  assert.equal(request.headers['x-opencode-client'], 'cli')
  assert.match(request.headers['user-agent'], /^opencode\//)
  assert.equal(request.body.stream, true)
  assert.equal(request.body.model, 'deepseek-v4.1-flash-free', '发给上游的模型名不带来源前缀')
  const toolNames = request.body.tools.map(tool => tool.function.name)
  for (const gate of ['bash', 'glob', 'grep', 'read']) assert.ok(toolNames.includes(gate), `缺少门禁工具 ${gate}`)

  // 响应：bash 还给 Claude Code 交成 Bash，grep 是桩要丢掉
  const start = frames.find(frame => frame.event === 'content_block_start' && frame.data.content_block.type === 'tool_use')
  assert.equal(start.data.content_block.name, 'Bash')
  const partial = frames.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data.delta.partial_json ?? '').join('')
  assert.equal(partial, '{"command":"ls"}')
  assert.ok(!JSON.stringify(frames).includes('"grep"'), '桩工具的调用不能转发给 Claude Code')
  assert.equal(frames.find(frame => frame.event === 'message_delta').data.delta.stop_reason, 'tool_use')
})

test('Go 套餐：必须带 key 与会话头，且不需要免费档那套形状', async t => {
  const home = scratch()
  const { saveGoKey, goCredential, listModels, chat, OPENCODE_GO } = await import('../src/opencode.mjs')
  const seen = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/models') {
      seen.push({ url: req.url, headers: req.headers, body: undefined })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'opencode' }] }))
      return
    }
    const body = await readBody(req)
    seen.push({ url: req.url, headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([{ choices: [{ delta: { content: 'pong' } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const source = { ...OPENCODE_GO, baseUrl: `http://127.0.0.1:${server.address().port}` }

  // 没配 key：清单要报错，对话要返回可读失败（而不是发一个必然 401 的请求）
  assert.equal(goCredential(), undefined)
  await assert.rejects(() => listModels(source), /还没配置 API key/)
  assert.equal((await chat(source, 'x', { messages: [] })).ok, false)

  const first = saveGoKey('oc_sk_test_0000000000000000000000000000', { file: `${home}/credentials.json` })
  assert.equal(first.session.length > 8, true)
  // 会话 id 落盘复用：再存一次 key 不该换会话（换了会让同一台机器被看成很多客户端）
  // 但 key 本身要换新的 —— 断言里用的必须是**最后一次**存进去的那个
  const saved = saveGoKey('oc_sk_test_1111111111111111111111111111', { file: `${home}/credentials.json` })
  assert.equal(saved.session, first.session)

  const models = await listModels(source)
  assert.equal(models[0].id, 'deepseek-v4.1-flash')
  const listing = seen[0]
  assert.equal(listing.headers.authorization, `Bearer ${saved.apiKey}`)
  assert.equal(listing.headers['x-opencode-session'], saved.session, '清单请求也要带会话头')

  // 裸 OpenAI 报文就能过：不该被塞进门禁的四个桩工具，也不该强塞那 5 个 x-opencode-* 头
  const result = await chat(source, 'deepseek-v4.1-flash', { messages: [{ role: 'user', content: 'ping' }] })
  assert.equal(result.ok, true)
  const call = seen[1]
  assert.equal(call.headers.authorization, `Bearer ${saved.apiKey}`)
  assert.equal(call.headers['x-opencode-session'], saved.session)
  assert.equal(call.headers['x-opencode-client'], undefined, '认证通道不需要免费档的客户端头')
  assert.equal(call.body.stream, true)
  assert.equal(call.body.tools, undefined, '认证通道不需要补门禁工具')
  assert.equal(call.body.model, 'deepseek-v4.1-flash')
})
