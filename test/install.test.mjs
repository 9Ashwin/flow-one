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

test('「自己把桥跑起来」的命令：Windows 的 cmd / PowerShell 也得能照抄', async () => {
  const { serveCommand } = await import('../src/wizard.mjs')
  const command = serveCommand(8788, 'k-1')
  // `BRIDGE_PORT=8788 … node cli.mjs` 是 POSIX 赋值前缀，cmd 与 PowerShell 都不认；
  // 而这条提示恰恰在 Windows 上最常出现（那边没有后台常驻）
  assert.doesNotMatch(command, /BRIDGE_[A-Z_]+=/, '不能再给 POSIX 的 env 赋值前缀')
  assert.match(command, /--port 8788/)
  assert.match(command, /--api-key k-1/)

  // 光有文本不够：这条命令得真能被解析成「前台起桥 + 同一个端口/密钥」
  const { resolveConfig } = await import('../src/config.mjs')
  const parsed = resolveConfig({ argv: command.split(' ').slice(2), env: {} })
  assert.equal(parsed.command, 'serve')
  assert.equal(parsed.config.port, 8788)
  assert.equal(parsed.config.apiKey, 'k-1')
})

test('launchctl print 成功但没有 stdout（stdio:ignore 返回 null）不能被当成「服务没加载」', async () => {
  const { commandOutput } = await import('../src/install.mjs')
  // v0.3.0 是 `execFileSync(...).toString()`：stdio:'ignore' 的成功调用返回 null，
  // 于是抛 TypeError → launchdLoaded 把「已加载」判成「没加载」→ installService 跳过
  // bootout，bootstrap 撞上 Bootstrap failed: 5 → 返回 ok:false，而旧进程带着旧 API key
  // 继续跑。用户看到的是「配置写好了，Claude Code 却一直 401」。
  assert.equal(commandOutput(null), '', '成功但没输出 ≠ 失败')
  assert.equal(commandOutput(Buffer.from('ok')), 'ok', '有输出时照旧')
})

test('Windows：settings.json 被占用（rename EPERM）时，向导第 4 步仍要把配置写进去', async () => {
  const home = scratch()
  const { installClaudeSettings } = await import('../src/install.mjs')
  const dir = path.join(home, 'claude')
  const file = path.join(dir, 'settings.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ env: { KEEP: 'me' } }))

  // Windows 上「目标被占用」的表现就是 rename 报 EPERM（POSIX 上 rename 允许覆盖已打开的文件，
  // 所以这个行为在 mac/Linux 上造不出来，只能把平台连同 rename 一起换成 Windows 的样子）
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const realRename = fs.renameSync
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fs.renameSync = () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) }
  try {
    // 真机上这里直接把向导带崩了，且 settings.json 一个字都没写进去
    installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k-win', model: 'cn/x' })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    fs.renameSync = realRename
  }

  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.env.KEEP, 'me', '被占用不是吃掉别人配置的理由')
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8788')
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'k-win')
  assert.deepEqual(
    fs.readdirSync(dir).filter(name => name.endsWith('.tmp')),
    [],
    '退让路径也不能把临时文件留在人家的配置目录里',
  )
})

test('配反代是本分，写 Claude Code 配置是可选的：选了不写就一个字节都不碰', async () => {
  const home = scratch()
  const { applyClientConfig } = await import('../src/wizard.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = '{"env":{"KEEP":"me"},"model":"opus"}'
  fs.writeFileSync(file, original)

  const skipped = applyClientConfig({
    wantsClient: false, file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k', model: 'cn/x', contextWindow: 1_000_000,
  })
  assert.deepEqual(skipped, { written: false })
  assert.equal(fs.readFileSync(file, 'utf8'), original, '不写就是逐字节不变（Windows 上也就不会撞权限）')

  const written = applyClientConfig({
    wantsClient: true, file, baseUrl: 'http://127.0.0.1:8788', apiKey: 'k', model: 'cn/x', contextWindow: 1_000_000,
  })
  assert.equal(written.written, true)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.env.KEEP, 'me', '帮忙写也要合并，不能覆盖别人的键')
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8788')
  assert.equal(parsed.env.ANTHROPIC_MODEL, 'cn/x[1m]', '1M 窗口才加后缀')
})

test('「要帮哪些客户端」每次都问，默认项是上次的选择（选过的口径也要能改）', async () => {
  scratch()
  const { decideClientTargets } = await import('../src/wizard.mjs')
  const { clientChoice } = await import('../src/install.mjs')

  let asked = 0
  let answer = ['dsh']
  let lastPrompt
  const ask = async prompt => { asked += 1; lastPrompt = prompt; return answer }
  assert.deepEqual(await decideClientTargets({ ask }), ['dsh'])
  assert.equal(asked, 1)
  assert.deepEqual(clientChoice(), { asked: true, clients: ['dsh'] })
  assert.equal(lastPrompt.options.length, 4, '四个选项：Claude Code / DSH / 两个都 / 都不写')

  // 第二次仍然问（这正是「选过也能改口径」），默认项停在上次的选择
  answer = ['claude']
  assert.deepEqual(await decideClientTargets({ ask }), ['claude'])
  assert.equal(asked, 2, '每次都问')
  assert.equal(lastPrompt.initial, 1, '默认项 = 上次的选择（DSH）')
  assert.deepEqual(clientChoice(), { asked: true, clients: ['claude'] })

  // 显式 --clients 跳过提问，且不落账本
  assert.deepEqual(await decideClientTargets({ clients: [], ask }), [])
  assert.equal(asked, 2)
  assert.deepEqual(clientChoice(), { asked: true, clients: ['claude'] }, 'flag 是「这一次」的表态')

  // 已经归我们管的客户端会被并进来（换密钥不回写会让客户端 401）
  assert.deepEqual(await decideClientTargets({ ours: ['claude'], ask }), ['claude'])
  assert.equal(asked, 3)
})

test('接入信息：只打印地址/令牌/模型 ID，1M 窗口才带 [1m] 后缀', async () => {
  const { connectionInfo } = await import('../src/wizard.mjs')
  const { sizedModelId } = await import('../src/install.mjs')
  const text = connectionInfo({ port: 8788, apiKey: 'k-1', model: 'cn/deepseek-v4.1-flash', contextWindow: 1_000_000 })
  assert.match(text, /http:\/\/127\.0\.0\.1:8788/)
  assert.match(text, /k-1/)
  assert.match(text, /cn\/deepseek-v4\.1-flash\[1m\]/)
  // 200k 的模型不能带后缀（会把上下文压缩拖到 1M，撞模型真实上限）
  assert.doesNotMatch(connectionInfo({ port: 8788, apiKey: 'k', model: 'cn/hy3', contextWindow: 192_000 }), /\[1m\]/)
  assert.equal(sizedModelId('cn/x', 200_000), 'cn/x')
  assert.equal(sizedModelId('cn/x', 200_001), 'cn/x[1m]')
  assert.equal(sizedModelId('cn/x[1m]', undefined), 'cn/x[1m]')
})

test('接入参数记在账本 bridge 段：不写客户端配置也能拿到令牌，卸载后一起忘掉', async () => {
  const home = scratch()
  const { bridgeRecord, recordBridge, clientChoice, recordClientChoice } = await import('../src/install.mjs')
  recordBridge({ port: 8788, apiKey: 'k-1', model: 'cn/x', contextWindow: 1_000_000 })
  assert.equal(bridgeRecord().port, 8788)
  assert.equal(bridgeRecord().apiKey, 'k-1')
  assert.equal(bridgeRecord().model, 'cn/x')

  recordClientChoice([])
  // 卸载（服务那块走「本来就没装过」的路径）也要把这两问的答案忘掉
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-install-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = dir
  try {
    const { uninstallService } = await import('../src/install.mjs')
    uninstallService()
  } finally {
    process.env.HOME = previousHome
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'))
  assert.equal('bridge' in ledger, false, '卸载后账本不该留桥的令牌')
  assert.equal('clients' in ledger, false, '「帮哪些客户端」也该重新问')
  assert.deepEqual(bridgeRecord(), {})
  assert.deepEqual(clientChoice(), { asked: false, clients: [] })
})

test('配置指向本桥时 opt-out 不许把旧密钥/旧模型留着（2026-10-22 真机 401 的回归）', async () => {
  const home = scratch()
  const { clientConfigIsOurs, installClaudeSettings, recordClientChoice } = await import('../src/install.mjs')
  const { decideClientConfig } = await import('../src/wizard.mjs')
  const file = path.join(home, 'claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const write = value => fs.writeFileSync(file, JSON.stringify(value))

  // 指向本桥 = 我们的配置
  write({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } })
  assert.equal(clientConfigIsOurs({ port: 8788, file }), true)
  write({ env: { ANTHROPIC_BASE_URL: 'http://localhost:8788' } })
  assert.equal(clientConfigIsOurs({ port: 8788, file }), true)
  // 别人的配置不接管
  write({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
  assert.equal(clientConfigIsOurs({ port: 8788, file }), false)
  write({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' } })
  assert.equal(clientConfigIsOurs({ port: 8788, file }), false, '端口不同就不是本桥')
  write({})
  assert.equal(clientConfigIsOurs({ port: 8788, file }), false)
  fs.writeFileSync(file, '{坏 JSON')
  assert.equal(clientConfigIsOurs({ port: 8788, file }), false, '读不懂就当作不是我们的')
  // 账本记过我们写过 → 就算我们的（端口换了也认：那份配置是我们留下的）
  installClaudeSettings({ file, baseUrl: 'http://127.0.0.1:9999', apiKey: 'k', model: 'cn/x' })
  assert.equal(clientConfigIsOurs({ port: 8788, file }), true)

  // 用户上次选了「都不写」：配置是我们的时仍然回写，且不再问
  recordClientChoice([])
  let asked = 0
  const ask = async () => { asked += 1; return [] }
  const { decideClientTargets } = await import('../src/wizard.mjs')
  assert.deepEqual(await decideClientTargets({ ours: ['claude'], ask }), ['claude'], '换了密钥/模型不回写会让客户端 401')
  assert.equal(asked, 1, '仍然会问（口径可改），但「已经归我们管」的被无条件并进来')
  // 但显式 --clients none 永远优先，且不触发提问
  assert.deepEqual(await decideClientTargets({ clients: [], ours: ['claude'], ask }), [])
  assert.equal(asked, 1)
  // 不属于本桥时按问出来的答案执行（这次问的是「都不写」）
  assert.deepEqual(await decideClientTargets({ ours: [], ask }), [])
  assert.equal(asked, 2)
})

test('桥的口令必须稳定：复用已有的，第一次装落固定默认值（不再每次 setup 换钥匙）', async () => {
  scratch()
  const { bridgeApiKey } = await import('../src/wizard.mjs')
  const { recordBridge } = await import('../src/install.mjs')
  const { DEFAULT_LOCAL_API_KEY } = await import('../src/config.mjs')

  // 没装过：固定默认值，两次调用必须一样（随机会让客户端配置与 DSH 的凭据引用当场失效）
  assert.equal(DEFAULT_LOCAL_API_KEY, 'flow-one-local')
  assert.equal(bridgeApiKey({ record: {}, settings: {} }), DEFAULT_LOCAL_API_KEY)
  assert.equal(bridgeApiKey({ record: {}, settings: {} }), DEFAULT_LOCAL_API_KEY)

  // 已有：复用，不重新生成
  recordBridge({ port: 8788, apiKey: 'existing-key', model: 'cn/x' })
  assert.equal(bridgeApiKey(), 'existing-key')
  // 账本里没有、但旧版写在 settings.json 里的：也复用（升级不能把人家配置弄失效）
  assert.equal(bridgeApiKey({ record: {}, settings: { env: { ANTHROPIC_AUTH_TOKEN: 'from-settings' } } }), 'from-settings')
  // 空串当没有：回落到默认
  assert.equal(bridgeApiKey({ record: { apiKey: '' }, settings: {} }), DEFAULT_LOCAL_API_KEY)
})

test('DSH 的 provider 必须覆盖所有挂着来源：配了 cn 和 intl 就两个都在', async () => {
  scratch()
  const { recordBridge, installStatePath } = await import('../src/install.mjs')
  const { CN, INTL } = await import('../src/products.mjs')
  const { dshProducts } = await import('../src/wizard.mjs')

  // 账本记着「cn、intl 都挂」：无论这次选哪一家，DSH 都要拿到两条线
  recordBridge({ port: 8788, apiKey: 'k', model: 'cn/x' })
  const state = JSON.parse(fs.readFileSync(installStatePath(), 'utf8'))
  state.service = { env: { BRIDGE_PRODUCTS: 'cn,intl,oc,ocg' } }
  fs.writeFileSync(installStatePath(), JSON.stringify(state))

  assert.deepEqual(dshProducts(CN).map(s => s.id), ['cn', 'intl'])
  assert.deepEqual(dshProducts(INTL).map(s => s.id), ['cn', 'intl'], '选 intl 也要带上 cn，反之亦然')
  assert.deepEqual(dshProducts(undefined).map(s => s.id), ['cn', 'intl'])

  // 这次接的是网关也无所谓：DSH 里挂着的腾讯两条线照样要写
  const GATEWAY = { id: 'gateway', label: '网关' }
  assert.deepEqual(dshProducts(GATEWAY).map(s => s.id), ['cn', 'intl'])
  // 只挂 oc/ocg 时没有腾讯来源：DSH 侧就没东西可写（不该硬造一个空 provider）
  assert.deepEqual(dshProducts(CN, []), [])
})
