import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

/** 假门禁：只认 stream / 四个工具 / 会话形状，故意**不**检查 session-id 别名。 */
function fakeGate({ alwaysReject = false } = {}) {
  return http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const session = req.headers['x-opencode-session'] ?? ''
    const tools = Array.isArray(body.tools) ? body.tools.map(tool => tool.function?.name) : []
    const ok = !alwaysReject
      && body.stream === true
      && ['bash', 'glob', 'grep', 'read'].every(name => tools.includes(name))
      && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session)
    res.writeHead(ok ? 200 : 403, { 'content-type': ok ? 'text/event-stream' : 'application/json' })
    res.end(ok
      ? 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n'
      : JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode." } }))
  })
}

test('门禁探针：逐项重推，能判定哪一条必填、哪一条已被上游放松', async t => {
  process.env.BRIDGE_HOME = (await import('node:fs')).mkdtempSync('/tmp/fo-doc-')
  const { probeOpencodeGate } = await import('../src/doctor.mjs')
  const server = fakeGate()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const result = await probeOpencodeGate({ baseUrl: `http://127.0.0.1:${server.address().port}` })
  const verdict = label => result.rows.find(row => row.label.startsWith(label))?.verdict

  assert.equal(result.tightened, false, '完整形状能过，就不该判成收紧')
  assert.equal(verdict('完整形状'), 'pass')
  // 假门禁不检查这个头 → 去掉也能过 → 应判成「已放松」而不是失败
  assert.equal(verdict('去掉 x-opencode-session-id'), 'relaxed')
  // 这三条假门禁确实在查 → 去掉应被拒 → 判成「必填项仍然成立」
  assert.equal(verdict('会话 id 尾段写成 26 位'), 'pass')
  assert.equal(verdict('tools 里不带'), 'pass')
  assert.equal(verdict('stream: false'), 'pass')
})

test('门禁探针：完整形状被拒时判成「上游收紧」', async t => {
  process.env.BRIDGE_HOME = (await import('node:fs')).mkdtempSync('/tmp/fo-doc-')
  const { probeOpencodeGate } = await import('../src/doctor.mjs')
  const server = fakeGate({ alwaysReject: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const result = await probeOpencodeGate({ baseUrl: `http://127.0.0.1:${server.address().port}` })
  assert.equal(result.tightened, true)
  assert.equal(result.rows.length, 1, '完整形状就过不了，后面的变体不必再发')
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
