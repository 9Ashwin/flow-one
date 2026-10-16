import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'

const tempHome = prefix => fs.mkdtempSync(`${os.tmpdir()}/${prefix}`)

/**
 * 假门禁（离线，不建连接）：只认 stream / 四个小写工具 / 会话 id 形状。
 *
 * 故意**不**检查 `x-opencode-session-id` 别名头：真实上游 2026-10-16 起也不再要求它，
 * 所以「去掉别名头」这一条变体应判成 relaxed（上游放松），而不是 fail。
 */
function fakeGateFetch() {
  const calls = []
  const fetchImpl = async (url, init) => {
    const request = { url, headers: { ...init.headers }, body: JSON.parse(init.body) }
    calls.push(request)
    const session = request.headers['x-opencode-session'] ?? ''
    const tools = Array.isArray(request.body.tools) ? request.body.tools.map(tool => tool.function?.name) : []
    const ok = request.body.stream === true
      && ['bash', 'glob', 'grep', 'read'].every(name => tools.includes(name))
      && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session)
    return ok
      ? { ok: true, status: 200, text: async () => 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n' }
      : { ok: false, status: 403, text: async () => JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode." } }) }
  }
  return { calls, fetchImpl }
}

/** 上游整体收紧 / 整体限流时的假 fetch：每一次都回同一个应答。 */
function fakeAlwaysFetch(status, errorType, message) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) })
    return { ok: false, status, text: async () => JSON.stringify({ type: 'error', error: { type: errorType, message } }) }
  }
  return { calls, fetchImpl }
}

test('门禁探针：逐项重推，能判定哪一条必填、哪一条已被上游放松', async () => {
  process.env.BRIDGE_HOME = tempHome('fo-doc-')
  const { probeOpencodeGate } = await import('../src/doctor.mjs')
  const { calls, fetchImpl } = fakeGateFetch()
  const result = await probeOpencodeGate({ fetchImpl })
  const verdict = label => result.rows.find(row => row.label.startsWith(label))?.verdict

  assert.equal(result.tightened, false, '完整形状能过，就不该判成收紧')
  assert.equal(verdict('完整形状'), 'pass')
  // 假门禁不检查这个头 → 去掉也能过 → 应判成「已放松」而不是失败
  assert.equal(verdict('去掉 x-opencode-session-id'), 'relaxed')
  // 这三条假门禁确实在查 → 去掉应被拒 → 判成「必填项仍然成立」
  assert.equal(verdict('会话 id 尾段写成 26 位'), 'pass')
  assert.equal(verdict('tools 里不带'), 'pass')
  assert.equal(verdict('stream: false'), 'pass')

  // ── 端点与请求头逐项（探针不许自己再写一份字面量：拼出 /inference/v1/v1/… 会 404）──
  const [complete, withoutAlias, wrongShape, noTools, noStream] = calls
  assert.equal(complete.url, 'https://opencode.ai/inference/v1/chat/completions')
  assert.ok(!complete.url.includes('/v1/v1'), 'URL 不能拼成 /inference/v1/v1/…')
  assert.equal(complete.headers.authorization, 'Bearer public', '匿名档的凭据是字面量 public')
  assert.equal(complete.headers['content-type'], 'application/json')
  assert.equal(complete.headers.accept, 'text/event-stream')
  assert.equal(Object.keys(complete.headers).filter(key => key.startsWith('x-opencode-')).length, 5, '五个 x-opencode-* 头')
  assert.match(complete.headers['x-opencode-project'], /^[0-9a-f]{40}$/)
  assert.match(complete.headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(complete.headers['x-opencode-session'].slice(4).length, 26, '尾段总长 26 = 12 hex + 14 base62')
  assert.equal(complete.headers['x-opencode-session-id'], complete.headers['x-opencode-session'], '别名头与 session 同值')
  assert.match(complete.headers['x-opencode-request'], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(complete.headers['x-opencode-client'], 'cli')
  assert.match(complete.headers['user-agent'], /^opencode\//)

  // ── 请求体逐项 ──
  assert.equal(complete.body.model, 'deepseek-v4.1-flash-free')
  assert.equal(complete.body.stream, true)
  assert.deepEqual(complete.body.tools.map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  for (const tool of complete.body.tools) {
    assert.equal(tool.type, 'function')
    assert.equal(tool.function.name, tool.function.name.toLowerCase(), '门禁工具名必须是小写')
    assert.ok(Object.keys(tool.function.parameters.properties).length >= 1, '每个门禁工具至少声明一个 property')
  }
  assert.deepEqual(complete.body.messages, [{ role: 'user', content: 'ping' }])

  // ── 每个变体只去掉一样东西 ──
  assert.equal(withoutAlias.headers['x-opencode-session-id'], undefined)
  assert.equal(wrongShape.headers['x-opencode-session'].slice(4).length, 38, '错形状是尾段 26 位随机段（总长 38）')
  assert.equal(wrongShape.headers['x-opencode-session'], wrongShape.headers['x-opencode-session-id'])
  assert.equal(noTools.body.tools, undefined)
  assert.equal(noStream.body.stream, false)

  // 凭据可注入：换一个 key，发出去的头就得跟着换（否则这个注入点是死的）
  const injected = fakeGateFetch()
  await probeOpencodeGate({ fetchImpl: injected.fetchImpl, anonymousKey: 'sk-test' })
  assert.equal(injected.calls[0].headers.authorization, 'Bearer sk-test')
})

test('门禁探针：完整形状被拒时判成「上游收紧」', async () => {
  process.env.BRIDGE_HOME = tempHome('fo-doc-')
  const { probeOpencodeGate } = await import('../src/doctor.mjs')
  const { fetchImpl } = fakeAlwaysFetch(403, 'FreeTierError', "OpenCode's free tier can only be used from within OpenCode.")
  const result = await probeOpencodeGate({ fetchImpl })
  assert.equal(result.tightened, true)
  assert.equal(result.inconclusive, false)
  assert.equal(result.rows[0].verdict, 'fail', '完整形状被门禁拒 = 上游收紧了')
  assert.equal(result.rows.length, 1, '完整形状就过不了，后面的变体不必再发')
})

test('门禁探针：完整形状 429 / 连不上时判「判不出来」，不冤枉成上游收紧', async () => {
  process.env.BRIDGE_HOME = tempHome('fo-doc-')
  const { probeOpencodeGate } = await import('../src/doctor.mjs')
  const { fetchImpl } = fakeAlwaysFetch(429, 'RateLimitError', 'Too many requests')
  const result = await probeOpencodeGate({ fetchImpl })
  assert.equal(result.rows[0].verdict, 'inconclusive', '限流不是门禁问题')
  assert.equal(result.tightened, false, '限流不能被报成「上游收紧了」')
  assert.equal(result.inconclusive, true)
  assert.equal(result.rows.length, 1, '判不出来时不必再发变体')

  // 连不上（status 0）同理：网络问题与「上游收紧」是两回事
  const offline = await probeOpencodeGate({ fetchImpl: async () => { throw new Error('fetch failed') } })
  assert.equal(offline.rows[0].status, 0)
  assert.equal(offline.rows[0].verdict, 'inconclusive')
  assert.equal(offline.tightened, false)
})

test('腾讯失败分类：风控拦截与额度受限必须分开', async () => {
  const { classifyTencentFailure } = await import('../src/doctor.mjs')
  // 真实见过的两种响应
  const blocked = classifyTencentFailure('{"code":11128,"msg":"请求被拦截，Illegal API invocation from an unapproved channel"}')
  assert.deepEqual(blocked, { blocked: true, limited: false })
  const limited = classifyTencentFailure('您的使用量已超出频率限制，将在 2026-10-17 17:41:48 UTC+8 重置')
  assert.deepEqual(limited, { blocked: false, limited: true }, '额度受限不能报成门禁失效')
  assert.deepEqual(classifyTencentFailure('Invalid API key'), { blocked: false, limited: false })
})

/** 一次假发送：把探针**真正发出去**的报文记下来，不碰网络。 */
function fakeTencentChat(reply) {
  const calls = []
  return {
    calls,
    chat: async (product, body, options) => {
      calls.push({ product, body, options })
      return reply
    },
  }
}

/** 探针离线跑的三个注入点：凭据、模型清单、发送那一步。 */
const tencentProbe = reply => ({ credential: { accessToken: 'x' }, models: [{ id: 'deepseek-v4.1-flash' }], ...fakeTencentChat(reply) })

const sseOk = { ok: true, response: { status: 200, text: async () => 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n' } }
/** buddy.mjs 的失败形状（它已经把上游的 msg 解出来了）。 */
const buddyFailure = (status, message) => ({ ok: false, status, message })

test('腾讯风控探针：system 走自己的改写器，三条字面量都清掉 → pass', async () => {
  const { probeTencentFingerprint } = await import('../src/doctor.mjs')
  const { CN } = await import('../src/products.mjs')
  const { calls, chat } = fakeTencentChat(sseOk)
  const result = await probeTencentFingerprint(CN, { credential: { accessToken: 'x' }, models: [{ id: 'deepseek-v4.1-flash' }], chat })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'pass')

  const sent = calls[0].body
  const system = sent.messages.find(message => message.role === 'system').content
  // 关键：探针必须走「翻译层 + 改写器」。改写器是按**带前缀**的模型 ID 挑的
  // （`cn/…`），拿上游目录里的裸 ID 去问会永远拿到 undefined，三条字面量就原样发出去了。
  assert.ok(!system.includes("Anthropic's official CLI for Claude"), '身份句必须被改写掉')
  assert.ok(system.includes('You are Claude Code, an official CLI for Claude'), '改写要保持语义（身份句还在）')
  assert.ok(!system.includes('Main branch (you will usually use this for PRs)'), 'gitStatus 主分支句必须被改写')
  assert.ok(system.includes('Main branch (PRs usually go here)'))
  assert.ok(!system.includes('x-anthropic-billing-header'), '计费头整行必须删掉')

  assert.deepEqual(sent.messages.at(-1), { role: 'user', content: 'ping' }, '用户内容逐字节不变')
  assert.equal(sent.stream, true)
  assert.equal(sent.max_tokens, 8)
  assert.equal(calls[0].options.model, 'deepseek-v4.1-flash')
})

test('腾讯风控探针：200 / 11128 / 429 三种结局各判一档', async () => {
  const { probeTencentFingerprint } = await import('../src/doctor.mjs')
  const { CN } = await import('../src/products.mjs')

  // ① 200：改写器生效
  const passed = await probeTencentFingerprint(CN, tencentProbe(sseOk))
  assert.equal(passed.verdict, 'pass')

  // ② 400 + 11128：被内容风控拦下 —— 这条才是「指纹规则失效」
  const blocked = await probeTencentFingerprint(CN, tencentProbe(buddyFailure(400, '请求被拦截，Illegal API invocation from an unapproved channel')))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.verdict, 'fail')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.limited, false)

  // ③ 429：额度/频率受限 —— 这一轮根本没验到改写器，不能报成规则失效
  const limited = await probeTencentFingerprint(CN, tencentProbe(buddyFailure(429, '您的使用量已超出频率限制，将在 2026-10-17 17:41:48 UTC+8 重置')))
  assert.equal(limited.verdict, 'inconclusive')
  assert.equal(limited.limited, true, '额度受限要单独报出来（不是门禁问题）')
  assert.equal(limited.blocked, false)
})

test('腾讯风控探针：流内 {code,msg} 11128（HTTP 200）也算被拦', async () => {
  const { probeTencentFingerprint } = await import('../src/doctor.mjs')
  const { CN } = await import('../src/products.mjs')
  const inStream = { ok: true, response: { status: 200, text: async () => 'data: {"code":11128,"msg":"请求被拦截"}\n\n' } }
  const result = await probeTencentFingerprint(CN, tencentProbe(inStream))
  assert.equal(result.ok, false, 'HTTP 200 但内容一个字都没出 —— 不能判成通过')
  assert.equal(result.verdict, 'fail')
  assert.equal(result.blocked, true)
})

test('腾讯风控探针：未登录时跳过并说明，不抛错也不打网络', async () => {
  process.env.BRIDGE_HOME = tempHome('fo-doc-anon-')
  const { probeTencentFingerprint } = await import('../src/doctor.mjs')
  const { CN } = await import('../src/products.mjs')
  const result = await probeTencentFingerprint(CN, { chat: async () => assert.fail('未登录时不该发请求') })
  assert.equal(result.skipped, true)
  assert.equal(result.verdict, 'inconclusive')
  assert.match(result.message, /未登录/)
})

test('本地体检：密钥不一致 / 模型不一致 / 服务跑着别的代码 / 没人监听', async () => {
  const { localIssues } = await import('../src/doctor.mjs')
  const clean = localIssues({
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'intl/x[1m]' }, model: 'intl/x[1m]' },
    serviceEnv: { BRIDGE_API_KEY: 'k', BRIDGE_PORT: '8789' },
    serviceCli: '/repo/cli.mjs', runningCli: '/repo/cli.mjs', healthOk: true,
  })
  assert.deepEqual(clean.issues, [])
  assert.ok(clean.ok.length >= 4)

  const messy = localIssues({
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789', ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_MODEL: 'oc/deepseek-v4.1-flash-free' }, model: 'workbuddy/deepseek-v4.1-flash[1m]' },
    serviceEnv: { BRIDGE_API_KEY: 'old', BRIDGE_PORT: '8788' },
    serviceCli: '/global/snapshot/cli.mjs', runningCli: '/repo/cli.mjs', healthOk: false,
  })
  const texts = messy.issues.map(issue => issue.text).join('\n')
  assert.match(texts, /密钥与服务的 BRIDGE_API_KEY 不一致/)
  assert.match(texts, /端口 8789 与服务端口 8788/)
  assert.match(texts, /顶层 model/)
  assert.match(texts, /服务跑的不是当前这份代码/)
  assert.match(texts, /没有服务在跑/)
  for (const issue of messy.issues) assert.ok(issue.fix !== undefined && issue.fix !== '', '每条问题都要给修法')
})

test('Go 套餐探针：会话头必填这条事实会被重推出来', async t => {
  const fs = await import('node:fs')
  process.env.BRIDGE_HOME = fs.mkdtempSync('/tmp/fo-goprobe-')
  const { saveGoKey, OPENCODE_GO } = await import('../src/opencode.mjs')
  const { probeOpencodeGo } = await import('../src/doctor.mjs')
  // 假上游：只认「带 key + 带会话头」，缺会话头就回 MissingSessionID（真上游的行为）
  const server = http.createServer(async (req, res) => {
    if (req.url === '/models') {
      res.writeHead(req.headers.authorization?.startsWith('Bearer ') ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }))
      return
    }
    if (req.headers['x-opencode-session'] === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const source = { ...OPENCODE_GO, baseUrl: `http://127.0.0.1:${server.address().port}` }

  // 没配 key 时整节跳过（不报错）
  assert.equal((await probeOpencodeGo(source)).configured, false)

  saveGoKey('oc_sk_probe_000000000000000000000000000')
  const result = await probeOpencodeGo(source)
  assert.equal(result.configured, true)
  const verdict = label => result.rows.find(row => row.label.startsWith(label))?.verdict
  assert.equal(verdict('带 x-opencode-session'), 'pass')
  assert.equal(verdict('不带 x-opencode-session'), 'pass', '缺会话头被拒 → 这条必填项仍然成立')
  assert.equal(verdict('模型清单要 key'), 'pass')
  assert.equal(result.rows.find(row => row.label.startsWith('模型清单')).count, 1)
})

test('Go 套餐探针：限流与连不上都判「判不出来」，不报成路子坏了', async t => {
  // 这个探针原先两个分支都返回 'fail' —— 429 会被报成「这条路有问题」，
  // 把人带去查会话头，而真正的原因是限流。
  const fs = await import('node:fs')
  process.env.BRIDGE_HOME = fs.mkdtempSync('/tmp/fo-goprobe-quota-')
  const { saveGoKey, OPENCODE_GO } = await import('../src/opencode.mjs')
  const { probeOpencodeGo } = await import('../src/doctor.mjs')

  const server = http.createServer((req, res) => {
    // 一切正常形状都对，但上游限流
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'rate_limited', message: 'Too many requests' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  saveGoKey('oc_sk_probe_quota_0000000000000000000000')
  const source = { ...OPENCODE_GO, baseUrl: `http://127.0.0.1:${server.address().port}` }
  const result = await probeOpencodeGo(source)
  assert.equal(result.configured, true)
  const verdicts = result.rows.map(row => `${row.label.slice(0, 6)}=${row.verdict}`)
  assert.ok(
    result.rows.every(row => row.verdict === 'inconclusive'),
    `限流时每一行都该是 inconclusive，实际：${verdicts.join(' ')}`,
  )
})
