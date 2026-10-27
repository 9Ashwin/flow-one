import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { SuiteContext, TestContext } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { OpenCodeSource, Upstream } from '../src/types.ts'

// 能力表是外部元数据；本机替身用例不能悄悄请求 models.dev。
// 钩子的形参类型是 `TestContext | SuiteContext`（`test.d.ts` 的 `HookFn`），运行时一定是 TestContext。
test.beforeEach((t: TestContext | SuiteContext) => {
  const context = t as TestContext
  const fetch = globalThis.fetch
  context.mock.method(globalThis, 'fetch', (url: string | URL | Request, options: RequestInit | undefined) => {
    if (String(url) === 'https://models.dev/api.json') {
      return Promise.resolve(Response.json({ opencode: { models: {} } }))
    }
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:/, '测试只允许本机替身请求')
    return fetch(url, options)
  })
})

/** 隔离的 BRIDGE_HOME：项目 id 会落到那里，不碰真实家目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-oc-'))
  process.env.BRIDGE_HOME = dir
  return dir
}

type GatedTool = { function: { name: string; parameters: { properties: Record<string, unknown> } } }
type ToolCallDelta = {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}
/** 假上游收到的请求：body 在 `/models` 上不存在。 */
type SeenRequest = { url?: string; headers: Record<string, string>; body: any }

/** 解析出来的一帧 SSE。 */
type ParsedFrame = { event: string | undefined; data: any }

type WireChunk = {
  choices?: { delta?: { tool_calls?: ToolCallDelta[]; content?: string }; message?: { content?: string } }[]
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const REQUEST_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('门禁形状：会话 / 请求 id 的位数与字符集必须是官方那一套', async () => {
  scratch()
  const { sessionId, requestId, projectId } = await import('../src/opencode.ts')
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
  const { applyFreeTierGate, GATE_TOOLS } = await import('../src/opencode.ts')
  const gated = applyFreeTierGate({
    stream: false,
    tools: [
      {
        type: 'function',
        function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      },
      {
        type: 'function',
        function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      },
      { type: 'function', function: { name: 'Edit', parameters: { type: 'object' } } },
    ],
  })
  assert.equal(gated.body.stream, true, '门禁要求 stream: true')
  const names = (gated.body.tools as unknown as GatedTool[]).map(tool => tool.function.name)
  for (const gate of GATE_TOOLS) assert.ok(names.includes(gate), `缺少门禁工具 ${gate}`)
  assert.equal(names.filter((name: string) => name === 'bash').length, 1, '不能重复补桩')
  assert.equal(names.filter((name: string) => name === 'Edit').length, 1, '非门禁工具原样保留（大小写也不动）')
  // 调用方自己声明过的：出站小写、响应要改回原名
  assert.equal(gated.rename.get('bash'), 'Bash')
  assert.equal(gated.rename.get('read'), 'Read')
  // 调用方没声明的：桩，响应里要丢弃
  assert.deepEqual([...gated.stubs].sort(), ['glob', 'grep'])
  for (const name of ['glob', 'grep']) {
    const tools = gated.body.tools as unknown as GatedTool[]
    const tool = tools.find(item => item.function.name === name) as GatedTool
    assert.ok(Object.keys(tool.function.parameters.properties).length > 0, '桩工具至少要声明一个 property')
  }
})

test('响应侧：改回调用方原名，桩工具的调用整条丢弃', async () => {
  scratch()
  const { restoreToolCalls } = await import('../src/opencode.ts')
  const rename = new Map([['bash', 'Bash']])
  const stubs = new Set(['glob'])
  async function* source() {
    yield {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash', arguments: '{"command":' } }] } },
      ],
    }
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }
    yield {
      choices: [
        { delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] } },
      ],
    }
    yield { choices: [{ delta: { content: '完成' } }] }
  }
  const out: WireChunk[] = []
  for await (const chunk of restoreToolCalls(source(), { rename, stubs })) out.push(chunk as WireChunk)
  const names = out.flatMap(chunk =>
    (chunk.choices ?? []).flatMap(choice =>
      (choice.delta?.tool_calls ?? []).map(call => call.function?.name).filter(Boolean),
    ),
  )
  assert.deepEqual(names, ['Bash'], 'bash 还原成 Bash；glob 是桩，整条丢弃')
  // 参数分片要原样跟着走，不能被改名逻辑吃掉
  const args = out
    .flatMap(chunk =>
      (chunk.choices ?? []).flatMap(choice =>
        (choice.delta?.tool_calls ?? []).map(call => call.function?.arguments).filter(Boolean),
      ),
    )
    .join('')
  assert.equal(args, '{"command":"ls"}')
})

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

const sse = (frames: unknown[]) =>
  `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`

function parseFrames(text: string) {
  return text
    .split('\n\n')
    .filter((block: string) => block.trim() !== '')
    .map((block: string) => ({
      event: /event: (.+)/.exec(block)?.[1],
      data: JSON.parse(/data: ([\s\S]+)/.exec(block)?.[1] ?? '{}'),
    }))
}

test('端到端：Claude Code 的请求经桥 → OpenCode 免费档，工具名来回都对得上', async t => {
  scratch()
  const seen: SeenRequest[] = []
  const upstream = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash-free' }, { id: 'deepseek-v4.1-flash' }] }))
      return
    }
    const body = await readBody(req)
    seen.push({ body, headers: req.headers as Record<string, string> })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c0', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
      ]),
    )
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())

  const { OPENCODE } = await import('../src/opencode.ts')
  const { createDirectUpstream } = await import('../src/upstreams.ts')
  const { createBridgeServer } = await import('../src/server.ts')
  const source = {
    ...OPENCODE,
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  } as typeof OPENCODE
  const model = 'oc/deepseek-v4.1-flash-free'
  const bridge = createBridgeServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      model,
      apiKey: '',
      modelMap: {},
      maxTokensCap: 0,
      showThinking: false,
      heartbeatMs: 0,
      fingerprintRewrite: true,
    },
    upstream: createDirectUpstream(
      { products: [source], credentialFile: path.join(scratch(), 'none.json') },
      { log: () => {} },
    ) as unknown as Upstream,
    log: () => {},
  })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      stream: true,
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: '列出当前目录' }],
      tools: [
        {
          name: 'Bash',
          description: '执行命令',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    }),
  })
  assert.equal(response.status, 200)
  const frames = parseFrames(await response.text())

  // 出站报文必须是门禁形状
  const [request] = seen
  assert.match(request.headers['x-opencode-project'], /^[0-9a-f]{40}$/)
  assert.equal(
    request.headers['x-opencode-session'],
    request.headers['x-opencode-session-id'],
    '别名头必须与 session 一致',
  )
  assert.match(request.headers['x-opencode-session'], SESSION_PATTERN)
  assert.match(request.headers['x-opencode-request'], REQUEST_PATTERN)
  assert.equal(request.headers['x-opencode-client'], 'cli')
  assert.match(request.headers['user-agent'], /^opencode\//)
  assert.equal(request.body.stream, true)
  assert.equal(request.body.model, 'deepseek-v4.1-flash-free', '发给上游的模型名不带来源前缀')
  const toolNames = (request.body.tools as unknown as GatedTool[]).map(tool => tool.function.name)
  for (const gate of ['bash', 'glob', 'grep', 'read']) assert.ok(toolNames.includes(gate), `缺少门禁工具 ${gate}`)

  // 响应：bash 还给 Claude Code 交成 Bash，grep 是桩要丢掉
  const start = frames.find(
    (frame: ParsedFrame) => frame.event === 'content_block_start' && frame.data.content_block.type === 'tool_use',
  ) as ParsedFrame
  assert.equal(start.data.content_block.name, 'Bash')
  const partial = frames
    .filter((frame: ParsedFrame) => frame.event === 'content_block_delta')
    .map((frame: ParsedFrame) => frame.data.delta.partial_json ?? '')
    .join('')
  assert.equal(partial, '{"command":"ls"}')
  assert.ok(!JSON.stringify(frames).includes('"grep"'), '桩工具的调用不能转发给 Claude Code')
  assert.equal(frames.find((frame: ParsedFrame) => frame.event === 'message_delta')?.data.delta.stop_reason, 'tool_use')
})

test('Go 套餐：必须带 key 与会话头，且不需要免费档那套形状', async t => {
  const home = scratch()
  const { saveGoKey, goCredential, listModels, chat, OPENCODE_GO } = await import('../src/opencode.ts')
  type GoSource = Parameters<typeof listModels>[0]
  const seen: SeenRequest[] = []
  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === '/models') {
      seen.push({ url: req.url, headers: req.headers as Record<string, string>, body: undefined })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'opencode' }] }))
      return
    }
    const body = await readBody(req)
    seen.push({ url: req.url, headers: req.headers as Record<string, string>, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sse([
        { choices: [{ delta: { content: 'pong' } }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  // 本地替身只换 baseUrl；OPENCODE_GO 的其余字段（匿名 key、TTL 等）对 Go 通道用不上。
  const source = {
    ...OPENCODE_GO,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  } as unknown as OpenCodeSource

  // 没配 key：清单要报错，对话要返回可读失败（而不是发一个必然 401 的请求）
  assert.equal(goCredential(), undefined)
  await assert.rejects(() => listModels(source), /no API key configured/)
  assert.equal(((await chat(source, 'x', { messages: [] })) as { status?: number }).status, 401)

  const first = saveGoKey('oc_sk_test_0000000000000000000000000000', { file: `${home}/credentials.json` }) as {
    session: string
    apiKey: string
  }
  assert.equal(first.session.length > 8, true)
  // 会话 id 落盘复用：再存一次 key 不该换会话（换了会让同一台机器被看成很多客户端）
  // 但 key 本身要换新的 —— 断言里用的必须是**最后一次**存进去的那个
  const saved = saveGoKey('oc_sk_test_1111111111111111111111111111', { file: `${home}/credentials.json` }) as {
    session: string
    apiKey: string
  }
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

test('过滤桩工具后的稀疏/反序索引在非流式和流式都保留所有真实工具', async () => {
  const { restoreToolCalls } = await import('../src/opencode.ts')
  const { createOutcome, foldChunk, anthropicMessage, createStreamTranslator } = await import('../src/anthropic.ts')
  for (const indices of [[1], [3, 1], [0, 2]]) {
    const calls = indices.map(index => ({
      index,
      id: `real-${index}`,
      function: { name: 'bash', arguments: '{"command":' },
    }))
    const stubIndex = indices.includes(0) ? 1 : 0
    const chunks = (async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: stubIndex, id: 'stub', function: { name: 'grep', arguments: '{}' } }, ...calls],
            },
          },
        ],
      }
      yield {
        choices: [
          {
            delta: { tool_calls: indices.map(index => ({ index, function: { arguments: '"ls"}' } })) },
            finish_reason: 'tool_calls',
          },
        ],
      }
    })()
    const outcome = createOutcome()
    const frames: any[] = []
    const translator = createStreamTranslator({
      model: 'oc/test',
      id: 'test',
      write: (frame: string) => frames.push(JSON.parse(frame.split('\ndata: ')[1])),
    })
    for await (const chunk of restoreToolCalls(chunks, {
      rename: new Map([['bash', 'Bash']]),
      stubs: new Set(['grep']),
    })) {
      foldChunk(outcome, chunk)
      translator.push(chunk)
    }
    translator.end()
    const message = anthropicMessage(outcome, { model: 'oc/test', id: 'test' })
    const content = message.content as { id: string; name: string; input: unknown }[]
    assert.deepEqual(content.map(call => call.id).sort(), indices.map(index => `real-${index}`).sort())
    for (const call of content) {
      assert.equal(call.name, 'Bash')
      assert.deepEqual(call.input, { command: 'ls' })
    }
    const starts = frames.filter((frame: any) => frame.type === 'content_block_start')
    assert.equal(starts.length, indices.length)
    assert.ok(starts.every((frame: any) => frame.content_block.name === 'Bash'))
    assert.ok(!JSON.stringify(frames).includes('stub'))
  }
})

test('免费档无索引工具分片必须按身份跟踪，桩工具不能误删真实工具', async () => {
  const { restoreToolCalls } = await import('../src/opencode.ts')
  const chunks = (async function* () {
    yield { choices: [{ delta: { tool_calls: [{ id: 'stub', function: { name: 'grep', arguments: '{}' } }] } }] }
    yield { choices: [{ delta: { tool_calls: [{ id: 'real', function: { name: 'bash', arguments: '{}' } }] } }] }
  })()
  const out = []
  for await (const chunk of restoreToolCalls(chunks, { rename: new Map([['bash', 'Bash']]), stubs: new Set(['grep']) }))
    out.push(chunk)
  assert.match(JSON.stringify(out), /"name":"Bash"/)
  assert.doesNotMatch(JSON.stringify(out), /"name":"grep"/)
})
