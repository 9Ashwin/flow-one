import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { readStore } from '../src/auth.ts'
import { projectId, persistedSession } from '../src/opencode.ts'
import { CN } from '../src/products.ts'
import { createDirectUpstream } from '../src/upstreams.ts'
import { createBridgeServer } from '../src/server.ts'
import { validateListenAuth } from '../src/config.ts'

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fo-migration-'))
}

test('a same-size credential replacement with unchanged mtime must become visible', t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, 'credentials.json')
  const stamp = new Date('2020-01-01T00:00:00Z')
  fs.writeFileSync(file, JSON.stringify({ cn: { accessToken: 'AAAA' } }))
  fs.utimesSync(file, stamp, stamp)
  assert.equal(readStore(file).cn?.accessToken, 'AAAA')
  const replacement = path.join(home, 'replacement')
  fs.writeFileSync(replacement, JSON.stringify({ cn: { accessToken: 'BBBB' } }))
  fs.utimesSync(replacement, stamp, stamp)
  fs.renameSync(replacement, file)
  assert.equal(readStore(file).cn?.accessToken, 'BBBB')
})

test('first use and concurrent processes retain the same OpenCode project and session', async t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ other: 'preserved' }))
  const script = `import {projectId,persistedSession} from './src/opencode.ts'; console.log(JSON.stringify({session:persistedSession(process.argv[1]),projectId:projectId(process.argv[1])}))`
  const processes = Array.from(
    { length: 8 },
    () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], { cwd: process.cwd() })
        let output = ''
        let errors = ''
        child.stdout.on('data', chunk => {
          output += chunk
        })
        child.stderr.on('data', chunk => {
          errors += chunk
        })
        child.on('error', reject)
        child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error(errors))))
      }),
  )
  const identities = (await Promise.all(processes)).map(output => JSON.parse(output))
  for (const identity of identities) assert.deepEqual(identity, identities[0])
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'opencode.json'), 'utf8'))
  assert.equal(stored.other, 'preserved')
  assert.equal(stored.session, identities[0].session)
  assert.equal(stored.projectId, identities[0].projectId)
  assert.equal(persistedSession(home), stored.session)
  assert.equal(projectId(home), stored.projectId)
})

test('missing Tencent login returns HTTP 401 and Anthropic authentication_error', async t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const upstream = createDirectUpstream({ products: [CN], credentialFile: path.join(home, 'credentials.json') })
  const bridge = createBridgeServer({
    config: { host: '127.0.0.1', port: 0, model: 'cn/example', apiKey: '', modelMap: {}, heartbeatMs: 0 },
    upstream,
    log: () => {},
  })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cn/example', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 401)
  const body = (await response.json()) as { error: { type: string } }
  assert.equal(body.error.type, 'authentication_error')
})

test('invalid CLI values and invalid environment values return their correct JSON error categories', t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const cases = [
    { argv: ['--port', 'bad'], env: {}, exit: 2, type: 'validation' },
    { argv: ['--unknown'], env: {}, exit: 2, type: 'validation' },
    { argv: ['--mode', 'bad'], env: {}, exit: 2, type: 'validation' },
    { argv: ['--product', 'bad'], env: {}, exit: 2, type: 'validation' },
    { argv: [], env: { BRIDGE_PORT: 'bad' }, exit: 4, type: 'config' },
    { argv: [], env: { BRIDGE_PRODUCTS: 'bad' }, exit: 4, type: 'config' },
    { argv: [], env: { BRIDGE_HEARTBEAT_MS: 'bad' }, exit: 4, type: 'config' },
    { argv: [], env: { BRIDGE_HOST: '0.0.0.0' }, exit: 4, type: 'config' },
  ]
  for (const item of cases) {
    const result = spawnSync(process.execPath, ['cli.ts', '--json', ...item.argv], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, BRIDGE_HOME: home, ...item.env },
    })
    assert.equal(result.status, item.exit, result.stderr)
    assert.equal(JSON.parse(result.stderr).error.type, item.type)
    assert.equal(result.stdout, '')
  }
})

test('scoped IPv6 loopback does not throw Invalid URL or trust scoped public addresses', () => {
  assert.doesNotThrow(() => validateListenAuth({ host: '::1%lo0', apiKey: '' }))
  assert.doesNotThrow(() => validateListenAuth({ host: 'fe80::1%en0', apiKey: 'private-key' }))
  assert.throws(() => validateListenAuth({ host: 'fe80::1%en0', apiKey: '' }), /non-loopback/)
})

test('legacy Go credentials keep a stable routing session without rewriting credentials', async t => {
  const home = scratch()
  const previous = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const file = path.join(home, 'credentials.json')
  const original = JSON.stringify({ 'opencode-go': { apiKey: 'oc_sk_test_secret' } })
  fs.writeFileSync(file, original)
  const { goCredential } = await import('../src/opencode.ts')
  const first = goCredential()?.session
  assert.match(first ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(goCredential()?.session, first)
  const script = `import {goCredential} from './src/opencode.ts'; console.log(goCredential().session)`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BRIDGE_HOME: home },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), first)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('cache diagnostics distinguish missing usage from zero and never log prompt content', async t => {
  const logs: string[] = []
  let calls = 0
  const upstream = {
    describe: () => 'fake',
    loadModels: async () => [],
    chat: async () => ({
      ok: true as const,
      chunks: (async function* () {
        calls++
        yield {
          choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          ...(calls === 1 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 0 } }),
        }
      })(),
    }),
  }
  const bridge = createBridgeServer({
    config: { host: '127.0.0.1', port: 0, model: 'test', apiKey: '', modelMap: {}, heartbeatMs: 0 },
    upstream,
    log: line => logs.push(line),
  })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        system: 'private-system-sentinel',
        messages: [{ role: 'user', content: 'private-user-sentinel' }],
        stream,
      }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  const lines = logs.filter(line => line.includes('prefix_id='))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /cache_read=unknown cache_ratio=unknown/)
  assert.match(lines[1], /cache_read=0 .*cache_ratio=0\.0000/)
  assert.equal(/prefix_id=([a-f0-9]+)/.exec(lines[0])?.[1], /prefix_id=([a-f0-9]+)/.exec(lines[1])?.[1])
  assert.ok(lines.every(line => !line.includes('private-')))
})

test('Tencent streaming forwards the usage request so cache metrics can be reported', async () => {
  const { toBuddyBody } = await import('../src/buddy.ts')
  const body = toBuddyBody(
    { messages: [{ role: 'system', content: 'system' }], stream_options: { include_usage: true } },
    { model: 'example' },
  )
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('a cache hit without an upstream prompt total reports an unknown ratio in both response modes', async t => {
  const logs: string[] = []
  const upstream = {
    describe: () => 'fake',
    loadModels: async () => [],
    chat: async () => ({
      ok: true as const,
      chunks: (async function* () {
        yield {
          choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_cache_hit_tokens: 50, completion_tokens: 1 },
        }
      })(),
    }),
  }
  const bridge = createBridgeServer({
    config: { host: '127.0.0.1', port: 0, model: 'test', apiKey: '', modelMap: {}, heartbeatMs: 0 },
    upstream,
    log: line => logs.push(line),
  })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }], stream }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  const lines = logs.filter(line => line.includes('prefix_id='))
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line, /cache_read=50 .*cache_ratio=unknown/)
})

test('empty and abandoned identity locks recover concurrently without overwriting identity', async t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const lock = path.join(home, 'opencode.json.lock')
  fs.writeFileSync(lock, '')
  fs.writeFileSync(`${lock}.recovery`, '')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  fs.utimesSync(`${lock}.recovery`, old, old)
  const script = `import {projectId,persistedSession} from './src/opencode.ts'; console.log(JSON.stringify({session:persistedSession(process.argv[1]),projectId:projectId(process.argv[1])}))`
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, home], { cwd: process.cwd() })
      let out = '',
        err = ''
      child.stdout.on('data', data => {
        out += data
      })
      child.stderr.on('data', data => {
        err += data
      })
      child.on('error', reject)
      child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(err))))
    })
  const results = (await Promise.all(Array.from({ length: 8 }, run))).map(value => JSON.parse(value))
  for (const result of results) assert.deepEqual(result, results[0])
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'opencode.json'), 'utf8'))
  assert.deepEqual(results[0], { session: stored.session, projectId: stored.projectId })
})

test('a live identity lock causes only a temporary fallback, then retries after release', t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const lock = path.join(home, 'opencode.json.lock')
  fs.writeFileSync(lock, String(process.pid))
  const temporary = projectId(home)
  assert.equal(fs.existsSync(path.join(home, 'opencode.json')), false)
  fs.unlinkSync(lock)
  const persistent = projectId(home)
  assert.notEqual(persistent, temporary)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'opencode.json'), 'utf8')).projectId, persistent)
})

test('an incompatible gateway rejects usage options once and can be explicitly configured to omit them', async t => {
  const { createGatewayUpstream } = await import('../src/upstreams.ts')
  const http = await import('node:http')
  const seen: Record<string, unknown>[] = []
  const fake = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    seen.push(body)
    if (body.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unsupported stream_options' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const port = (fake.address() as AddressInfo).port
  const upstream = createGatewayUpstream({ upstream: `http://127.0.0.1:${port}` })
  for (const allowed of [true, false]) {
    const bridge = createBridgeServer({
      config: { host: '127.0.0.1', port: 0, model: 'test', apiKey: '', modelMap: {}, upstreamUsage: allowed },
      upstream,
    })
    const address = (await bridge.listen()) as AddressInfo
    t.after(() => bridge.close())
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, allowed ? 400 : 200)
    await response.text()
    await bridge.close()
  }
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0].stream_options, { include_usage: true })
  assert.equal(seen[1].stream_options, undefined)
  const { resolveConfig } = await import('../src/config.ts')
  assert.equal(resolveConfig({ env: {}, argv: ['--no-upstream-usage'] }).config.upstreamUsage, false)
  assert.equal(resolveConfig({ env: { BRIDGE_UPSTREAM_USAGE: '0' }, argv: [] }).config.upstreamUsage, false)
  const { serveCommand } = await import('../src/wizard.ts')
  assert.match(serveCommand(8788, '', 'test', { BRIDGE_UPSTREAM_USAGE: '0' }), /--no-upstream-usage/)
})

test('cache benchmark sends a stable multi-turn prefix and never prints content or credentials', async t => {
  const http = await import('node:http')
  const bodies: Array<{ system: string; messages: unknown[] }> = []
  const fake = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    assert.equal(req.headers['x-api-key'], 'test-local-secret')
    bodies.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        content: [{ type: 'text', text: 'private-model-response' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 50 },
      }),
    )
  })
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const port = (fake.address() as AddressInfo).port
  const child = spawn(process.execPath, ['scripts/cache-benchmark.ts', `http://127.0.0.1:${port}`, 'test/model'], {
    cwd: process.cwd(),
    env: { ...process.env, FO_CACHE_BENCH_API_KEY: 'test-local-secret' },
  })
  let output = '',
    error = ''
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    error += chunk
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(code, 0, error)
  const rows = output
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(
    rows.map(row => row.turn),
    [1, 2, 3, 4],
  )
  assert.deepEqual(
    bodies.map(body => body.messages.length),
    [1, 3, 5, 7],
  )
  assert.ok(bodies.every(body => body.system === bodies[0].system))
  assert.ok(!output.includes('test-local-secret') && !output.includes('private-model-response'))
})

test('a dead lock owner is reclaimed and the recovered identity is persisted', t => {
  const home = scratch()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const lock = path.join(home, 'opencode.json.lock')
  fs.writeFileSync(lock, '99999999')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  const project = projectId(home)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'opencode.json'), 'utf8')).projectId, project)
  assert.equal(fs.existsSync(lock), false)
})

test('an unwritable OpenCode home logs temporary identity and retries on the next request', async t => {
  const home = scratch()
  const previous = process.env.BRIDGE_HOME
  const blocked = path.join(home, 'blocked')
  fs.writeFileSync(blocked, 'file, not directory')
  process.env.BRIDGE_HOME = blocked
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const logs: string[] = []
  const { OPENCODE, chat } = await import('../src/opencode.ts')
  t.mock.method(globalThis, 'fetch', async () => new Response('data: [DONE]\n\n'))
  const first = await chat(
    OPENCODE,
    'example',
    { messages: [{ role: 'user', content: 'hi' }] },
    { log: line => logs.push(line) },
  )
  assert.equal(first.ok, true)
  assert.ok(logs.some(line => line.includes('temporary identity')))
  fs.unlinkSync(blocked)
  const second = await chat(
    OPENCODE,
    'example',
    { messages: [{ role: 'user', content: 'hi' }] },
    { log: line => logs.push(line) },
  )
  assert.equal(second.ok, true)
  assert.equal(fs.existsSync(path.join(blocked, 'opencode.json')), true)
})
