import test from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { ChatResult, OpenAiRequestBody, Upstream } from '../src/types.ts'
import { createBridgeServer } from '../src/server.ts'
import { resolveConfig } from '../src/config.ts'

const candidates = ['intl/test', 'cn/test', 'ocg/test']
const config = {
  host: '127.0.0.1',
  port: 0,
  apiKey: '',
  model: 'auto',
  modelMap: {},
  fallbackModels: candidates,
  heartbeatMs: 0,
}
const requestBody = {
  model: 'auto',
  system: "You are Claude Code, Anthropic's official CLI for Claude",
  messages: [{ role: 'user', content: 'hi' }],
}
const ok = (): ChatResult => ({
  ok: true,
  chunks: (async function* () {
    yield { choices: [{ delta: { content: 'success' }, finish_reason: 'stop' }] }
  })(),
})

async function bridgeWith(t: import('node:test').TestContext, chat: (body: OpenAiRequestBody) => Promise<ChatResult>) {
  const logs: string[] = []
  const upstream: Upstream = { describe: () => 'test', loadModels: async () => [], chat }
  const bridge = createBridgeServer({ config, upstream, log: line => logs.push(line) })
  const addr = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  return { url: `http://127.0.0.1:${addr.port}/v1/messages`, logs }
}
async function post(url: string, stream = false) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestBody, stream }),
  })
}

test('quota rejections follow configured order and retranslate Tencent and OpenCode independently', async t => {
  const seen: OpenAiRequestBody[] = []
  const { url, logs } = await bridgeWith(t, async body => {
    seen.push(body)
    return seen.length < 3 ? { ok: false, status: 429, message: 'quota exhausted' } : ok()
  })
  const response = await post(url)
  assert.equal(response.status, 200)
  const data = (await response.json()) as { model: string; content: Array<{ text: string }> }
  assert.equal(data.model, 'auto')
  assert.equal(data.content[0].text, 'success')
  assert.deepEqual(
    seen.map(item => item.model),
    candidates,
  )
  assert.ok(!String(seen[0].messages?.[0].content).includes("Anthropic's official CLI"))
  assert.ok(String(seen[2].messages?.[0].content).includes("Anthropic's official CLI"))
  assert.ok(logs.some(line => line.includes('fallback selected=ocg/test')))
  assert.ok(logs.some(line => line.includes('model=ocg/test stream=0')))
})

test('successful first candidate is recorded as the actual model without logging prompt content', async t => {
  const { url, logs } = await bridgeWith(t, async () => ok())
  const response = await post(url)
  assert.equal(response.status, 200)
  await response.text()
  assert.ok(logs.some(line => line.includes('model=intl/test stream=0')))
  assert.ok(logs.every(line => !line.includes('You are Claude Code')))
})

test('HTTP 200 quota error as the first SSE frame falls back before output', async t => {
  const seen: string[] = []
  const { url } = await bridgeWith(t, async body => {
    seen.push(body.model ?? '')
    if (seen.length === 1)
      return {
        ok: true,
        chunks: (async function* () {
          yield { error: { message: '14018 Credits exhausted' } }
        })(),
      }
    return ok()
  })
  const response = await post(url, true)
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /success/)
  assert.doesNotMatch(text, /Credits exhausted/)
  assert.deepEqual(seen, ['intl/test', 'cn/test'])
})

test('ordinary bad requests and connection failures are not retried', async t => {
  for (const failure of [
    { status: 400, message: 'invalid request' },
    { status: 502, message: 'connection reset' },
    { status: 403, message: '11128 channel verification failed' },
  ]) {
    let attempts = 0
    const { url } = await bridgeWith(t, async () => {
      attempts++
      return { ok: false, ...failure }
    })
    const response = await post(url)
    assert.equal(response.status, failure.status)
    assert.equal(attempts, 1)
    await response.text()
  }
})

test('after any SSE content there is no fallback on a later quota error', async t => {
  let attempts = 0
  const { url } = await bridgeWith(t, async () => {
    attempts++
    return {
      ok: true,
      chunks: (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] }
        yield { error: { message: '14018 Credits exhausted' } }
      })(),
    }
  })
  const response = await post(url, true)
  const text = await response.text()
  assert.match(text, /partial/)
  assert.match(text, /Credits exhausted/)
  assert.equal(attempts, 1)
})

test('fallback configuration requires an ordered list of mounted source models', () => {
  const parsed = resolveConfig({ env: {}, argv: ['--fallback', candidates.join(',')] })
  assert.equal(parsed.config.model, 'auto')
  assert.deepEqual(parsed.config.fallbackModels, candidates)
  assert.ok(['intl', 'cn', 'ocg'].every(id => parsed.config.products.some(source => source.id === id)))
  for (const value of ['intl/test', 'intl/test,intl/test', 'invalid/test,cn/test', 'intl/,ocg/test']) {
    assert.throws(() => resolveConfig({ env: {}, argv: ['--fallback', value] }), /fallback|model/)
  }
})

test('quota error after role-only metadata falls back without exposing either frame', async t => {
  const seen: string[] = []
  const { url } = await bridgeWith(t, async body => {
    seen.push(body.model ?? '')
    if (seen.length === 1)
      return {
        ok: true,
        chunks: (async function* () {
          yield { choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] }
          yield { error: { message: '14018 Credits exhausted' } }
        })(),
      }
    return ok()
  })
  const response = await post(url, true)
  const text = await response.text()
  assert.match(text, /success/)
  assert.doesNotMatch(text, /Credits exhausted/)
  assert.deepEqual(seen, ['intl/test', 'cn/test'])
})

test('temporarily limited candidates cool down and the next request goes directly to Go', async t => {
  const seen: string[] = []
  const { url } = await bridgeWith(t, async body => {
    seen.push(body.model ?? '')
    return body.model !== 'ocg/test' ? { ok: false, status: 429, message: 'quota', retryAfter: '60' } : ok()
  })
  for (let index = 0; index < 2; index++) {
    const response = await post(url)
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.deepEqual(seen, ['intl/test', 'cn/test', 'ocg/test', 'ocg/test'])
})

test('when every candidate is limited, repeat requests return 429 with Retry-After without resending', async t => {
  let attempts = 0
  const { url } = await bridgeWith(t, async () => {
    attempts++
    return { ok: false, status: 429, message: 'quota', retryAfter: '60' }
  })
  for (let index = 0; index < 2; index++) {
    const response = await post(url)
    assert.equal(response.status, 429)
    assert.ok(Number(response.headers.get('retry-after')) > 0)
    await response.text()
  }
  assert.equal(attempts, 3)
})

test('Tencent 14018 and missing login can fail over but content moderation cannot', async t => {
  for (const failure of [
    { status: 400, message: '14018 Credits exhausted' },
    { status: 401, message: 'not logged in' },
  ]) {
    let attempts = 0
    const { url } = await bridgeWith(t, async () => {
      attempts++
      return attempts === 1 ? { ok: false, ...failure } : ok()
    })
    const response = await post(url)
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(attempts, 2)
  }
})

test('fo auto writes one Claude model and persists the configured order for foreground use', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, '.flow-one')
  const claude = path.join(home, '.claude')
  fs.mkdirSync(bridge, { recursive: true })
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'ocg/old',
        serviceEnv: { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'ocg' },
        savedAt: '2026-01-01',
      },
    }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888', OTHER_SETTING: 'preserve' },
      model: 'ocg/old',
    }),
  )
  const run = spawnSync(process.execPath, ['cli.ts', 'auto', '--fallback', candidates.join(',')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(run.status, 0, run.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const ledger = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, 'auto')
  assert.equal(settings.env.ANTHROPIC_MODEL, 'auto')
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'auto')
  assert.equal(settings.env.OTHER_SETTING, 'preserve')
  assert.equal(ledger.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, candidates.join(','))
  assert.deepEqual(ledger.bridge.serviceEnv.BRIDGE_PRODUCTS.split(',').sort(), ['cn', 'intl', 'ocg'])
  assert.ok(fs.readdirSync(claude).some(name => name.includes('.bak-')))
  const reuse = spawnSync(process.execPath, ['cli.ts', 'use', 'auto'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(reuse.status, 0, reuse.stderr)
  const reused = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(reused.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, candidates.join(','))
})

test('an old source-prefixed model uses the unified route while auto mode is active', async t => {
  const seen: string[] = []
  const { url } = await bridgeWith(t, async body => {
    seen.push(body.model ?? '')
    return { ok: false, status: 429, message: 'limited' }
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestBody, model: 'cn/other-model' }),
  })
  assert.equal(response.status, 429)
  await response.text()
  assert.deepEqual(seen, candidates)
})

test('fo use auto defaults to each source last configured model instead of replacing the Go choice', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-last-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, '.flow-one'),
    claude = path.join(home, '.claude')
  fs.mkdirSync(bridge, { recursive: true })
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'ocg/beam-free',
        lastModels: { intl: { model: 'intl/previous' }, ocg: { model: 'ocg/beam-free' } },
        serviceEnv: { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'ocg' },
        savedAt: '2026-01-01',
      },
    }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888' } }),
  )
  const run = spawnSync(process.execPath, ['cli.ts', 'use', 'auto'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(run.status, 0, run.stderr)
  const state = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(state.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, 'intl/previous,cn/deepseek-v4.1-flash,ocg/beam-free')
})

test('an explicit unavailable model can fall back but a generic 404 cannot', async t => {
  for (const [message, expected] of [
    ['This model is not available in your country', 200],
    ['route not found', 404],
  ] as const) {
    let calls = 0
    const { url } = await bridgeWith(t, async () => {
      calls++
      return calls === 1 ? { ok: false, status: 404, message } : ok()
    })
    const response = await post(url)
    assert.equal(response.status, expected)
    await response.text()
    assert.equal(calls, expected === 200 ? 2 : 1)
  }
})

test('numeric quota SSE codes trigger fallback even when the upstream omits a message', async t => {
  let attempts = 0
  const { url } = await bridgeWith(t, async () => {
    attempts++
    return attempts === 1
      ? {
          ok: true,
          chunks: (async function* () {
            yield { error: { code: 429 } }
          })(),
        }
      : ok()
  })
  const response = await post(url, true)
  assert.match(await response.text(), /success/)
  assert.equal(attempts, 2)
})

test('explicit Claude model mappings take priority over auto routing', async t => {
  const seen: string[] = []
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: async () => [],
    chat: async body => {
      seen.push(body.model ?? '')
      return ok()
    },
  }
  const bridge = createBridgeServer({ config: { ...config, modelMap: { 'claude-special': 'ocg/custom' } }, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestBody, model: 'claude-special' }),
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.deepEqual(seen, ['ocg/custom'])
})

test('named tool choice skips unsupported Tencent candidates and reaches Go unchanged', async t => {
  const seen: OpenAiRequestBody[] = []
  const { url } = await bridgeWith(t, async body => {
    seen.push(body)
    return body.model?.startsWith('ocg/')
      ? ok()
      : { ok: false, status: 400, message: 'named tool choice is not supported by this source' }
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...requestBody,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'Read' },
    }),
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.deepEqual(
    seen.map(body => body.model),
    candidates,
  )
  assert.deepEqual(seen[2].tool_choice, { type: 'function', function: { name: 'Read' } })
})

test('image requests wait for candidate metadata and skip models that cannot read images', async t => {
  const seen: OpenAiRequestBody[] = []
  let release: (rows: import('../src/types.ts').UpstreamModel[]) => void = () => {}
  const catalogue = new Promise<import('../src/types.ts').UpstreamModel[]>(resolve => {
    release = resolve
  })
  const upstream: Upstream = {
    describe: () => 'test',
    loadModels: () => catalogue,
    chat: async body => {
      seen.push(body)
      return ok()
    },
  }
  const bridge = createBridgeServer({ config, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => {
    release([])
    return bridge.close()
  })
  const pending = fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
        },
      ],
    }),
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(seen.length, 0)
  release([
    { id: 'intl/test', supportsImages: false },
    { id: 'cn/test', supportsImages: true },
  ])
  const response = await pending
  assert.equal(response.status, 200)
  await response.text()
  assert.deepEqual(
    seen.map(item => item.model),
    ['cn/test'],
  )
  assert.ok(JSON.stringify(seen[0].messages).includes('data:image/png;base64,AAAA'))
})

test('an old Claude session pinned to a configured source still falls back through the unified route', async t => {
  for (const stream of [false, true]) {
    const seen: string[] = []
    const { url } = await bridgeWith(t, async body => {
      seen.push(body.model ?? '')
      return seen.length < 3 ? { ok: false, status: 429, message: 'quota exhausted' } : ok()
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...requestBody, model: 'cn/test[1m]', stream }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /success/)
    assert.match(text, /"model":"auto"/)
    assert.deepEqual(seen, candidates)
  }
})

test('backend candidate updates keep the unified route and use 1M only when every model supports it', async () => {
  const { updateFallbackModels, fallbackContextWindow } = await import('../src/use.ts')
  const original = ['intl/test', 'cn/test', 'ocg/test']
  assert.deepEqual(updateFallbackModels(original, 'cn/new'), ['intl/test', 'cn/new', 'ocg/test'])
  assert.deepEqual(updateFallbackModels(original, 'cn/new', true), ['cn/new', 'intl/test', 'ocg/test'])
  const last = {
    intl: { model: 'intl/test', contextWindow: 1_000_000 },
    cn: { model: 'cn/test', contextWindow: 1_000_000 },
    ocg: { model: 'ocg/test', contextWindow: 1_000_000 },
  }
  assert.equal(fallbackContextWindow(original, last), 1_000_000)
  assert.equal(fallbackContextWindow(original, last, { model: 'cn/test', contextWindow: 200_000 }), undefined)
  assert.equal(fallbackContextWindow(['intl/test', 'ocg/unknown'], last), undefined)
  assert.equal(fallbackContextWindow([], last), undefined)
})

test('fo use changes backend priority while Claude Code keeps its unified model', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-use-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, '.flow-one'),
    claude = path.join(home, '.claude')
  fs.mkdirSync(bridge, { recursive: true })
  fs.mkdirSync(claude, { recursive: true })
  const models = ['intl/deepseek-v4.1-flash', 'cn/deepseek-v4.1-flash', 'ocg/deepseek-v4.1-flash']
  const lastModels = Object.fromEntries(models.map(model => [model.split('/')[0], { model, contextWindow: 1_000_000 }]))
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'auto',
        lastModels,
        serviceEnv: {
          BRIDGE_MODE: 'direct',
          BRIDGE_MODEL: 'auto',
          BRIDGE_PRODUCTS: 'intl,cn,ocg',
          BRIDGE_FALLBACK_MODELS: models.join(','),
        },
        savedAt: '2026-01-01',
      },
    }),
  )
  fs.writeFileSync(
    path.join(bridge, 'credentials.json'),
    JSON.stringify({ cn: { accessToken: 'test', expiresAt: Date.now() + 3600000 } }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888', ANTHROPIC_MODEL: 'auto' }, model: 'auto' }),
  )
  const script = `globalThis.fetch = async () => Response.json({data:{models:[{id:'deepseek-v4.1-flash',maxInputTokens:1000000}]}}); process.argv=['node','cli.ts','use','cn']; await import('./cli.ts')`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(run.status, 0, run.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, 'auto[1m]')
  assert.equal(settings.env.ANTHROPIC_MODEL, 'auto[1m]')
  assert.equal(state.bridge.model, 'auto')
  assert.equal(state.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, [models[1], models[0], models[2]].join(','))
  assert.equal(state.bridge.lastModels.cn.model, models[1])
})

test('setup builds an automatic backend route from configured credentials in priority order', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-sources-'))
  const previous = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  fs.writeFileSync(
    path.join(home, 'credentials.json'),
    JSON.stringify({
      intl: { accessToken: 'test' },
      cn: { accessToken: 'test' },
      'opencode-go': { apiKey: 'test', session: 'test' },
    }),
  )
  const { configuredFallbackModels } = await import('../src/use.ts')
  const last = { intl: { model: 'intl/a' }, ocg: { model: 'ocg/b' } }
  assert.deepEqual(configuredFallbackModels('cn/custom', last), ['intl/a', 'cn/custom', 'ocg/b'])
  assert.deepEqual(configuredFallbackModels('oc/free', last), ['intl/a', 'cn/deepseek-v4.1-flash', 'ocg/b', 'oc/free'])
})

test('auto setup retains the one-million window only for matching configured backends', async t => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-window-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, '.flow-one'),
    claude = path.join(home, '.claude')
  fs.mkdirSync(bridge, { recursive: true })
  fs.mkdirSync(claude, { recursive: true })
  const models = ['intl/deepseek-v4.1-flash', 'cn/deepseek-v4.1-flash', 'ocg/deepseek-v4.1-flash']
  const lastModels = Object.fromEntries(models.map(model => [model.split('/')[0], { model, contextWindow: 1_000_000 }]))
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'cn/deepseek-v4.1-flash',
        lastModels,
        serviceEnv: { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'intl,cn,ocg' },
        savedAt: '2026-01-01',
      },
    }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888' }, model: 'cn/deepseek-v4.1-flash[1m]' }),
  )
  const result = spawnSync(process.execPath, ['cli.ts', 'auto'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const ledger = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, 'auto[1m]')
  assert.equal(ledger.bridge.model, 'auto')
  assert.equal(ledger.bridge.contextWindow, 1_000_000)
  assert.equal(ledger.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, models.join(','))
})

test('fo switch updates a backend model without replacing the unified Claude entry', async t => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-auto-switch-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, '.flow-one'),
    claude = path.join(home, '.claude')
  fs.mkdirSync(bridge, { recursive: true })
  fs.mkdirSync(claude, { recursive: true })
  const models = ['intl/deepseek-v4.1-flash', 'cn/deepseek-v4.1-flash', 'ocg/deepseek-v4.1-flash']
  const lastModels = Object.fromEntries(models.map(model => [model.split('/')[0], { model, contextWindow: 1_000_000 }]))
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'auto',
        lastModels,
        serviceEnv: {
          BRIDGE_MODE: 'direct',
          BRIDGE_MODEL: 'auto',
          BRIDGE_PRODUCTS: 'intl,cn,ocg',
          BRIDGE_FALLBACK_MODELS: models.join(','),
        },
        savedAt: '2026-01-01',
      },
    }),
  )
  fs.writeFileSync(
    path.join(bridge, 'credentials.json'),
    JSON.stringify({
      intl: { accessToken: 'test', expiresAt: Date.now() + 3600000 },
      cn: { accessToken: 'test', expiresAt: Date.now() + 3600000 },
      'opencode-go': { apiKey: 'test', session: 'test' },
    }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888', ANTHROPIC_MODEL: 'auto' }, model: 'auto' }),
  )
  const script = `
    import { PassThrough } from 'node:stream';
    import { setStdinForTest } from './src/prompt.ts';
    process.stdin.isTTY=true;process.stdout.isTTY=true;
    const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};setStdinForTest(input);
    globalThis.fetch=async url=>String(url).includes('models.dev') ? Response.json({opencode:{models:{'deepseek-v4.1-flash':{limit:{context:1000000}}}}}) : String(url).includes('opencode.ai') ? Response.json({data:[{id:'deepseek-v4.1-flash'}]}) : Response.json({data:{models:[{id:'deepseek-v4.1-flash',maxInputTokens:1000000}]}});
    process.argv=['node','cli.ts','switch'];setTimeout(()=>input.emit('keypress','1',{name:'1'}),400);await import('./cli.ts');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 6000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, 'auto[1m]')
  assert.equal(state.bridge.model, 'auto')
  assert.equal(state.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, models.join(','))
})
