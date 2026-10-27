import test from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveConfig } from '../src/config.ts'
import { createBridgeServer } from '../src/server.ts'
import { modelForSource } from '../src/use.ts'
import { OPENCODE_GO } from '../src/opencode.ts'
import type { ChatResult, Upstream } from '../src/types.ts'

const legacy = 'intl/example,cn/example,ocg/example'

test('switching back to Go keeps the remembered model instead of choosing an unusable free model', () => {
  const rows = [
    { id: 'ocg/beam-free', free: true, contextWindow: 500_000 },
    { id: 'ocg/deepseek-v4.1-flash', contextWindow: 1_000_000 },
  ]
  const lastModels = { ocg: { model: 'ocg/deepseek-v4.1-flash', contextWindow: 1_000_000 } }
  assert.deepEqual(modelForSource({ source: OPENCODE_GO, rows, lastModels }), {
    model: 'ocg/deepseek-v4.1-flash',
    contextWindow: 1_000_000,
  })
  assert.deepEqual(modelForSource({ source: OPENCODE_GO, rows, lastModels: {} }), {
    model: 'ocg/beam-free',
    contextWindow: 500_000,
  })
})

test('an upgraded automatic service uses only its former first model', () => {
  const { config } = resolveConfig({ env: { BRIDGE_MODEL: 'auto', BRIDGE_FALLBACK_MODELS: legacy }, argv: [] })
  assert.equal(config.model, 'intl/example')
  assert.ok(config.products.some(source => source.id === 'intl'))
  assert.throws(() => resolveConfig({ env: {}, argv: ['auto'] }))
  assert.throws(() => resolveConfig({ env: {}, argv: ['serve', '--fallback', legacy] }))
  assert.throws(() => resolveConfig({ env: { BRIDGE_MODEL: 'auto' }, argv: [] }))
})

test('selecting a source migrates an old auto installation to that direct model', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-single-route-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, 'bridge'),
    claude = path.join(home, 'claude')
  fs.mkdirSync(bridge)
  fs.mkdirSync(claude)
  const model = 'intl/deepseek-v4.1-flash'
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'auto',
        savedAt: '2026-01-01',
        lastModels: { intl: { model, contextWindow: 1_000_000 } },
        serviceEnv: {
          BRIDGE_MODE: 'direct',
          BRIDGE_MODEL: 'auto',
          BRIDGE_PRODUCTS: 'intl,cn,ocg',
          BRIDGE_FALLBACK_MODELS: legacy,
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(bridge, 'credentials.json'),
    JSON.stringify({ intl: { accessToken: 'test', expiresAt: Date.now() + 3600000 } }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888', ANTHROPIC_MODEL: 'auto' }, model: 'auto' }),
  )
  const script = `globalThis.fetch = async () => Response.json({data:{models:[{id:'deepseek-v4.1-flash',maxInputTokens:1000000}]}}); process.argv=['node','cli.ts','use','intl']; await import('./cli.ts')`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BRIDGE_HOME: bridge,
      CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: home,
    },
  })
  assert.equal(run.status, 0, run.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, `${model}[1m]`)
  assert.equal(state.bridge.model, model)
  assert.equal(state.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, undefined)
})

test('legacy auto requests resolve to one model and rejected requests never switch providers', async t => {
  const { config } = resolveConfig({ env: { BRIDGE_MODEL: 'auto', BRIDGE_FALLBACK_MODELS: legacy }, argv: [] })
  const attempts: string[] = []
  const upstream: Upstream = {
    describe: () => 'fixture',
    loadModels: async () => [],
    chat: async body => {
      attempts.push(String(body.model))
      return { ok: false, status: 429, message: 'quota exhausted' } as ChatResult
    },
  }
  const bridge = createBridgeServer({ config: { ...config, port: 0, apiKey: '' }, upstream })
  const address = (await bridge.listen()) as AddressInfo
  t.after(() => bridge.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto[1m]', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(response.status, 429)
  await response.text()
  assert.deepEqual(attempts, ['intl/example'])
})
