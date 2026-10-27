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
