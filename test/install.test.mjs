import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 每个用例一个隔离的 BRIDGE_HOME：安装状态与凭据都写到那里，绝不碰真实的家目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-install-'))
  process.env.BRIDGE_HOME = dir
  return dir
}

test('写 Claude Code 配置：合并而不是覆盖，写前先备份', async () => {
  const home = scratch()
  const { installClaudeSettings, uninstallClaudeSettings } = await import('../src/install.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:18899' },
    model: 'sonnet',
  }, null, 2))

  const applied = installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k-1', model: 'cn/deepseek-v4.1-flash' })
  assert.ok(fs.existsSync(applied.backup), '必须留下备份')
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  // 别人的键一个都不能少
  assert.deepEqual(written.permissions, { allow: ['Bash(ls:*)'] })
  assert.equal(written.env.DISABLE_TELEMETRY, '1')
  // 我们自己的键按预期落盘，模型带 [1m] 后缀（否则 Claude Code 只按 200k 压缩上下文）
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8788')
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'k-1')
  assert.equal(written.env.ANTHROPIC_MODEL, 'cn/deepseek-v4.1-flash[1m]')
  assert.equal(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'cn/deepseek-v4.1-flash[1m]')
  assert.equal(written.model, 'cn/deepseek-v4.1-flash[1m]', '不能留着会在网关里找不到的 sonnet 别名')
  // 不写 modelOverrides：那要靠把自己伪装成 Claude 的模型 ID 才能消诊断，代价太大
  assert.equal(written.modelOverrides, undefined)
  assert.equal(fs.statSync(path.join(home, 'install.json')).mode & 0o777, 0o600)
})

test('还原：只删自己写的且没被改过的键', async () => {
  const home = scratch()
  const { installClaudeSettings, uninstallClaudeSettings } = await import('../src/install.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ env: { KEEP: 'me' } }))
  installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k-2', model: 'cn/x' })

  // 用户自己改了令牌，还原时就不能动它
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'))
  edited.env.ANTHROPIC_AUTH_TOKEN = 'user-changed'
  fs.writeFileSync(file, JSON.stringify(edited))

  const result = uninstallClaudeSettings()
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.env.KEEP, 'me')
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'user-changed', '用户改过的值必须保留')
  assert.equal(after.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(after.env.ANTHROPIC_MODEL, undefined)
  assert.ok(result.removed.includes('ANTHROPIC_BASE_URL'))
  assert.ok(!result.removed.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('服务文件：launchd plist 与 systemd unit 都指向同一个入口', async () => {
  const home = scratch()
  const { launchAgentPlist, systemdUnit } = await import('../src/install.mjs')
  const plist = launchAgentPlist({ port: 8788, apiKey: 'k-3', node: '/usr/local/bin/node', cli: '/opt/ccb/cli.mjs', logDir: home })
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(plist, /<string>\/opt\/ccb\/cli\.mjs<\/string>/)
  assert.match(plist, /<key>BRIDGE_PORT<\/key>\s*<string>8788<\/string>/)
  assert.match(plist, /<key>BRIDGE_API_KEY<\/key>\s*<string>k-3<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>/)
  assert.match(plist, /<key>KeepAlive<\/key>/)

  // 服务是不带参数启动的：模式与模型必须落进服务环境，否则会退回默认配置
  const withEnv = launchAgentPlist({ port: 8788, apiKey: '', env: { BRIDGE_MODE: 'gateway', BRIDGE_MODEL: 'workbuddy/x' }, node: '/n', cli: '/c', logDir: home })
  assert.match(withEnv, /<key>BRIDGE_MODE<\/key>\s*<string>gateway<\/string>/)
  assert.match(withEnv, /<key>BRIDGE_MODEL<\/key>\s*<string>workbuddy\/x<\/string>/)
  assert.doesNotMatch(withEnv, /BRIDGE_API_KEY/, '空密钥不该写进服务文件')

  const unit = systemdUnit({ port: 9000, apiKey: 'k-4', env: { BRIDGE_MODE: 'direct' }, node: '/usr/bin/node', cli: '/opt/ccb/cli.mjs' })
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/ccb\/cli\.mjs/)
  assert.match(unit, /Environment=BRIDGE_PORT=9000/)
  assert.match(unit, /Environment=BRIDGE_API_KEY=k-4/)
  assert.match(unit, /Environment=BRIDGE_MODE=direct/)
  assert.match(unit, /WantedBy=default\.target/)
})


test('向导能认出「端口上跑的是本工具」而不是当成占用者', async () => {
  const http = await import('node:http')
  const { probeBridge } = await import('../src/wizard.mjs')
  // 本故障的真实形态：向导把上一次装的服务当成端口占用，建议换端口并写进配置，
  // 用户又没装服务 → Claude Code 连到一个没人听的端口。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'claude-code-openai-bridge', model: 'cn/x' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const found = await probeBridge(port)
    assert.equal(found?.model, 'cn/x')
    // 不是本工具的服务（没有 service 字段）不算命中
    const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
    try {
      assert.equal(await probeBridge(other.address().port), undefined)
    } finally { other.close() }
    // 没人听的端口是 undefined，不是抛错
    assert.equal(await probeBridge(9), undefined)
    assert.equal(await probeBridge(0), undefined)
  } finally {
    server.close()
  }
})
