import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { asBridgeError } from '../src/errors.ts'
import { resolveConfig } from '../src/config.ts'
import { applySwitch } from '../src/switch.ts'
import { choosePort, serveCommand } from '../src/wizard.ts'
import { installService, serviceState, setServiceRunnerForTest } from '../src/install.ts'

test('候选端口全部占用时应报错，不能写入无法连接的端口 0', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-ports-'))
  const previous = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const server = net.createServer(socket => socket.destroy())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  await assert.rejects(
    choosePort([(server.address() as AddressInfo).port]),
    error => asBridgeError(error)?.category === 'config',
  )
})

test('服务重启失败不能修改客户端模型或声称客户端已更新', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-switch-fail-'))
  const previous = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  const settings = path.join(home, 'settings.json')
  fs.writeFileSync(
    settings,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', ANTHROPIC_MODEL: 'cn/old' } }),
  )
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ service: { path: '/test/service' } }))
  const before = fs.readFileSync(settings, 'utf8')
  const result = await applySwitch({
    port: 8788,
    apiKey: 'key',
    model: 'oc/new',
    settings,
    install: async () => ({ ok: false, kind: 'launchd', path: '/test/service', reason: 'failed' }),
  })
  assert.equal(result.service?.ok, false)
  assert.equal(result.written, false)
  assert.equal(fs.readFileSync(settings, 'utf8'), before)
  const notReady = await applySwitch({
    port: 8788,
    apiKey: 'key',
    model: 'oc/new',
    settings,
    install: async () => ({ ok: true, kind: 'launchd', path: '/test/service', notes: [] }),
    healthy: async () => false,
  })
  assert.equal(notReady.service?.ok, false)
  assert.match(notReady.service?.reason ?? '', /did not start/)
  assert.equal(fs.readFileSync(settings, 'utf8'), before)
})

test('服务加载失败时恢复原服务文件并保留旧账本', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-service-rollback-'))
  const keys = ['HOME', 'USERPROFILE', 'BRIDGE_HOME', 'XDG_CONFIG_HOME'] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    BRIDGE_HOME: path.join(home, '.flow-one'),
    XDG_CONFIG_HOME: home,
  })
  t.after(() => {
    setServiceRunnerForTest()
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    fs.rmSync(home, { recursive: true, force: true })
  })
  const state = serviceState()
  if (!state.supported) return t.skip('service manager is unsupported on this platform')
  fs.mkdirSync(path.dirname(state.path), { recursive: true })
  fs.writeFileSync(state.path, 'original service', { mode: 0o600 })
  fs.mkdirSync(process.env.BRIDGE_HOME!, { recursive: true })
  const ledger = path.join(process.env.BRIDGE_HOME!, 'install.json')
  const old = JSON.stringify({ bridge: { port: 8788, model: 'old', apiKey: 'key' } })
  fs.writeFileSync(ledger, old)
  setServiceRunnerForTest(() => {
    throw new Error('simulated service failure')
  })
  const result = await installService({ port: 8788, apiKey: 'key', env: { BRIDGE_MODEL: 'new' } })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /previous service definition was restored/)
  assert.equal(fs.readFileSync(state.path, 'utf8'), 'original service')
  assert.equal(fs.readFileSync(ledger, 'utf8'), old)
})

test('前台命令保留模型及来源或网关配置，解析后可在任意目录使用', () => {
  for (const [model, env] of [
    ['ocg/example', { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'intl,ocg' }],
    [
      'custom-model',
      { BRIDGE_MODE: 'gateway', UPSTREAM_BASE_URL: 'http://127.0.0.1:8326', UPSTREAM_API_KEY: 'secret' },
    ],
  ] as const) {
    const command = serveCommand(8788, 'local-key', model, env)
    assert.match(command, /^fo serve /)
    const { config } = resolveConfig({ argv: command.split(' ').slice(1), env: {} })
    assert.equal(config.model, model)
    if (env.BRIDGE_MODE === 'gateway') {
      assert.equal(config.mode, 'gateway')
      assert.equal(config.upstream, env.UPSTREAM_BASE_URL)
      assert.equal(config.upstreamKey, env.UPSTREAM_API_KEY)
    } else
      assert.deepEqual(
        config.products.map(item => item.id),
        ['intl', 'ocg'],
      )
  }
})

test('前台命令中的特殊字符必须作为参数传递，不能被 shell 执行', t => {
  if (process.platform === 'win32') return t.skip('POSIX shell assertion')
  const value = "key'$(printf injected)"
  const command = serveCommand(8788, value, 'ocg/example')
  const args = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' })
    .trim()
    .split('\n')
  assert.equal(args[args.indexOf('--api-key') + 1], value)
})
