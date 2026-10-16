import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 每个用例一个隔离的 BRIDGE_HOME：安装状态与凭据都写到那里，绝不碰真实的家目录。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-install-'))
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

  const applied = installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k-1', model: 'cn/deepseek-v4.1-flash', contextWindow: 1_000_000 })
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
  assert.equal(written.model, 'cn/deepseek-v4.1-flash[1m]', 'model 字段与 env 必须同一个值：两个字段说法不一致会静默跑成另一个模型')
  // 不写 modelOverrides：那要靠把自己伪装成 Claude 的模型 ID 才能消诊断，代价太大
  assert.equal(written.modelOverrides, undefined)
  assert.equal(fs.statSync(path.join(home, 'install.json')).mode & 0o777, 0o600)
})

test('还原：只删自己写的且没被改过的键', async () => {
  const home = scratch()
  const { installClaudeSettings, uninstallClaudeSettings } = await import('../src/install.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ env: { KEEP: 'me' }, model: 'opus' }))
  installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k-2', model: 'cn/x', contextWindow: 1_000_000 })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'cn/x[1m]', '顶层 model 与 env 必须同一个值')

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
  assert.equal(after.model, 'opus', '顶层 model 要还原成安装前的值')
  assert.ok(result.removed.includes('ANTHROPIC_BASE_URL'))
  assert.ok(!result.removed.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('服务文件：launchd plist 与 systemd unit 都指向同一个入口', async () => {
  const home = scratch()
  const { launchAgentPlist, systemdUnit } = await import('../src/install.mjs')
  const plist = launchAgentPlist({ port: 8788, apiKey: 'k-3', node: '/usr/local/bin/node', cli: '/opt/fo/cli.mjs', logDir: home })
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(plist, /<string>\/opt\/fo\/cli\.mjs<\/string>/)
  assert.match(plist, /<key>BRIDGE_PORT<\/key>\s*<string>8788<\/string>/)
  assert.match(plist, /<key>BRIDGE_API_KEY<\/key>\s*<string>k-3<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>/)
  assert.match(plist, /<key>KeepAlive<\/key>/)

  // 服务是不带参数启动的：模式与模型必须落进服务环境，否则会退回默认配置
  const withEnv = launchAgentPlist({ port: 8788, apiKey: '', env: { BRIDGE_MODE: 'gateway', BRIDGE_MODEL: 'workbuddy/x' }, node: '/n', cli: '/c', logDir: home })
  assert.match(withEnv, /<key>BRIDGE_MODE<\/key>\s*<string>gateway<\/string>/)
  assert.match(withEnv, /<key>BRIDGE_MODEL<\/key>\s*<string>workbuddy\/x<\/string>/)
  assert.doesNotMatch(withEnv, /BRIDGE_API_KEY/, '空密钥不该写进服务文件')

  const unit = systemdUnit({ port: 9000, apiKey: 'k-4', env: { BRIDGE_MODE: 'direct' }, node: '/usr/bin/node', cli: '/opt/fo/cli.mjs' })
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/fo\/cli\.mjs/)
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
    res.end(JSON.stringify({ ok: true, service: 'flow-one', model: 'cn/x' }))
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

test('[1m] 后缀按真实窗口决定：200k 的模型不能登记成 1M', async () => {
  const home = scratch()
  const { installClaudeSettings } = await import('../src/install.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  // OpenCode 免费档的 deepseek-v4.1-flash-free 实测窗口是 200k：
  // 给它加 [1m] 会让 Claude Code 到 1M 才压缩上下文，然后撞上模型真实上限。
  const small = installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k', model: 'oc/deepseek-v4.1-flash-free', contextWindow: 200_000 })
  assert.equal(small.env.ANTHROPIC_MODEL, 'oc/deepseek-v4.1-flash-free')
  assert.equal(small.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'oc/deepseek-v4.1-flash-free')

  // 窗口未知时也不加（Claude Code 对未识别 ID 的默认假设正是 200k）
  const unknown = installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k', model: 'oc/whatever' })
  assert.equal(unknown.env.ANTHROPIC_MODEL, 'oc/whatever')

  // 超过 200k 才登记 1M
  const big = installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k', model: 'intl/deepseek-v4.1-flash', contextWindow: 1_000_000 })
  assert.equal(big.env.ANTHROPIC_MODEL, 'intl/deepseek-v4.1-flash[1m]')
})

test('服务代码路径解析：能看出服务跑的是哪份代码（全局快照 vs 当前仓库）', async () => {
  const { cliPathFromServiceFile } = await import('../src/install.mjs')
  // 真实形态：服务被全局安装的那份快照装上，于是「命令行有、服务里没有」
  const snapshot = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/me/.nvm/lib/node_modules/flow-one/cli.mjs</string>
  </array>
</dict></plist>`
  assert.equal(cliPathFromServiceFile(snapshot, 'launchd'), '/Users/me/.nvm/lib/node_modules/flow-one/cli.mjs')
  assert.equal(cliPathFromServiceFile('[Service]\nExecStart=/usr/bin/node /opt/fo/cli.mjs\n', 'systemd'), '/opt/fo/cli.mjs')
  assert.equal(cliPathFromServiceFile('', 'launchd'), undefined)
  assert.equal(cliPathFromServiceFile('<plist></plist>', 'launchd'), undefined)
})

test('systemd 用户会话：XDG_RUNTIME_DIR 为空时补上 /run/user/<uid>', async () => {
  const { xdgRuntimeDir } = await import('../src/install.mjs')
  // 真实形态（2026-10-16）：SSH / 非登录壳里这个变量是空的，于是 systemctl --user
  // 一律 `Failed to connect to bus: No medium found`，单元文件从没落地。
  assert.equal(xdgRuntimeDir({}, { uid: 1000, exists: () => true }), '/run/user/1000')
  // 显式给了就照用，不覆盖用户意图
  assert.equal(xdgRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, { uid: 1000, exists: () => false }), '/run/user/1000')
  // 只有空白也算没给
  assert.equal(xdgRuntimeDir({ XDG_RUNTIME_DIR: '  ' }, { uid: 7, exists: () => true }), '/run/user/7')
  // 目录不存在 = 根本没有用户会话，别硬凑一个路径出来
  assert.equal(xdgRuntimeDir({}, { uid: 1000, exists: () => false }), undefined)
  // uid 拿不到时（Windows 上没有 process.getuid）不能拼出 `/run/user/undefined`。
  // 这里传 null 而不是 undefined：后者会触发默认参数回填，测不到这条分支。
  assert.equal(xdgRuntimeDir({}, { uid: null, exists: () => true }), undefined)
})

test('服务加载失败：dbus 连不上时给可执行的下一步，而不是甩原文', async () => {
  const { serviceLoadReason } = await import('../src/install.mjs')
  const busDown = serviceLoadReason(
    'Command failed: systemctl --user enable --now dev.flow-one.service\nFailed to connect to bus: No medium found',
    '/home/me/.config/systemd/user/dev.flow-one.service',
  )
  assert.match(busDown, /没有可用的 systemd 用户会话/)
  assert.match(busDown, /loginctl enable-linger/)
  // 其余错误原样带出，不掩盖真因
  assert.match(serviceLoadReason('权限不足', '/x.service'), /权限不足/)
})

test('status：免费档报「无需登录」、Go 套餐报「配没配 key」，都不提不存在的 login', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-status-'))
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
  // oc 不需要凭据，ocg 的凭据存在 `opencode-go` 条目下而不是 `ocg`：
  // 两者都不能落到「未登录（login <id>）」那条分支上。
  const child = spawn(process.execPath, [cli, 'status'], {
    env: { ...process.env, BRIDGE_HOME: home, BRIDGE_PRODUCTS: 'oc,ocg' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 0, `两个来源都不该算错误状态（输出：${out}）`)
  assert.match(out, /无需登录/, '免费档要说清楚它不用登录')
  assert.match(out, /未配 key/, 'Go 套餐缺的是 key，不是登录态')
  // productByName 只认 cn / intl，login oc / login ocg 都是不存在的命令
  assert.doesNotMatch(out, /login (oc|ocg)/)
  assert.doesNotMatch(out, /未登录/, '这两条来源根本没有「未登录」这个状态')
})

// ── 「要不要装成开机自启」这一问的记忆 ──────────────────────────────────────
//
// 用户的原始抱怨：装过一次后台服务之后，每次配置都还要再问一遍。规则见 AGENTS.md §6。

/** 假的 serviceState：用例不碰本机的 launchd / systemd 也能喂出「装过 / 没装过」。 */
function fakeService(overrides = {}) {
  return { kind: 'launchd', path: '/tmp/dev.flow-one.plist', installed: false, legacyInstalled: false, supported: true, ...overrides }
}

/** 抓住 note / warn 打到 stdout 的内容，用来断言「屏幕上到底说了什么」（带颜色码，先剥掉）。 */
function captureStdout() {
  const original = process.stdout.write.bind(process.stdout)
  const chunks = []
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true }
  return {
    stop() { process.stdout.write = original },
    text() { return chunks.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') },
  }
}

test('后台服务：已经装过就不再问，直接更新', async () => {
  const home = scratch()
  const { decideService } = await import('../src/wizard.mjs')
  let asked = false
  const capture = captureStdout()
  let wants
  try {
    wants = await decideService({
      state: fakeService({ installed: true }),
      // 账本里是「拒绝过」也不算数：服务就在那儿，直接更新它
      choice: { asked: true, autoStart: false },
      ask: async () => { asked = true; return false },
    })
  } finally {
    capture.stop()
  }
  assert.equal(wants, true, '装过就直接更新')
  assert.equal(asked, false, '用户的抱怨正是这一问每次配置都还要再来一遍')
  assert.match(capture.text(), /后台服务已装.*本次直接更新/, '要说清楚为什么没问')
  assert.equal(fs.existsSync(path.join(home, 'install.json')), false, '没问就不该写账本')
})

test('后台服务：没问过就问一次（默认「要」），并把答案落盘', async () => {
  const home = scratch()
  const { decideService } = await import('../src/wizard.mjs')
  let asked = 0
  const wants = await decideService({
    state: fakeService(),
    ask: async ({ message, initial }) => {
      asked += 1
      assert.match(message, /开机自启/)
      assert.equal(initial, true, '默认是「要」')
      return true
    },
  })
  assert.equal(wants, true)
  assert.equal(asked, 1, '从没表态时要问一次')
  const file = path.join(home, 'install.json')
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(ledger.autoStart, true)
  assert.equal(ledger.autoStartAsked, true, '「问过」要单独记，否则「选了不装」和「没问过」分不开')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '账本与凭据同目录，权限不能松')
})

test('后台服务：上次选了不装就不再问，只提示怎么开启', async () => {
  const home = scratch()
  const { recordServiceChoice, serviceChoice } = await import('../src/install.mjs')
  // 相当于上一次向导里，用户在「装成开机自启？」答了「不装」
  recordServiceChoice(false)
  assert.deepEqual(serviceChoice(), { asked: true, autoStart: false })

  const { decideService } = await import('../src/wizard.mjs')
  const capture = captureStdout()
  let asked = false
  let wants
  try {
    // choice 走默认值 → 真的从 BRIDGE_HOME/install.json 里读回上次的答案
    wants = await decideService({ state: fakeService(), ask: async () => { asked = true; return true } })
  } finally {
    capture.stop()
  }
  assert.equal(wants, false)
  assert.equal(asked, false, '拒绝过就别再问第二遍')
  assert.match(capture.text(), /fo setup --service/, '要给出开启的办法，而不是只说一句「已跳过」')
  assert.ok(fs.existsSync(path.join(home, 'install.json')))
})

test('后台服务：显式 --service / --no-service 最优先，且不写账本', async () => {
  const home = scratch()
  const { decideService } = await import('../src/wizard.mjs')
  let asked = false
  const spy = async () => { asked = true; return true }

  // --no-service 压过「已经装了」：脚本要能明确表态不更新服务
  assert.equal(await decideService({ service: false, state: fakeService({ installed: true }), ask: spy }), false)
  // --service 压过「上次拒绝过」
  assert.equal(await decideService({ service: true, state: fakeService(), choice: { asked: true, autoStart: false }, ask: spy }), true)
  assert.equal(asked, false, '给了 flag 就不该再问')
  assert.equal(fs.existsSync(path.join(home, 'install.json')), false, 'flag 是「这一次」的表态，不落账本')
})

test('卸载：把「要不要自启」的答案一起忘掉，下次配置重新问', async () => {
  const home = scratch()
  // 服务文件的位置由 HOME 推出：给一个临时 HOME 就能走到「本来就没装过服务」那条路，
  // 既不碰真实家目录，也不会真去调 launchctl / systemctl。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-install-home-'))
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config')
  try {
    const { recordServiceChoice, serviceChoice, uninstallService } = await import('../src/install.mjs')
    recordServiceChoice(false)

    assert.equal(uninstallService().skipped, true, '这台机器上本来就没装过服务')

    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'))
    assert.equal('autoStart' in ledger, false, '卸载后不该还留着「不装」的答案')
    assert.equal('autoStartAsked' in ledger, false)
    assert.deepEqual(serviceChoice(), { asked: false, autoStart: false })

    // 用户既然卸载了，下次配置就该重新问一遍
    const { decideService } = await import('../src/wizard.mjs')
    let asked = 0
    await decideService({ state: fakeService(), ask: async () => { asked += 1; return true } })
    assert.equal(asked, 1)
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME
  }
})
