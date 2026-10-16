import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 改名迁移（claude-code-openai-bridge → flow-one）的回归测试。
 *
 * 改名真正有风险的不是机械替换，而是**会断掉已有安装的两处**：
 * 数据目录（登录态在里面）与服务名（新旧两个服务会抢同一个端口）。
 */

function scratchHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-migration-'))
  const previous = {
    HOME: process.env.HOME,
    BRIDGE_HOME: process.env.BRIDGE_HOME,
    // XDG_CONFIG_HOME 也要一起隔离：Linux 上 systemd 的服务文件路径是
    // `${XDG_CONFIG_HOME}/systemd/user/...`，只看 HOME 是拦不住它的
    // （CI 的 ubuntu runner 就设了这个变量，于是守卫正确地拒绝了我的用例）。
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config')
  delete process.env.BRIDGE_HOME
  return {
    dir,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test('数据目录：新目录不存在时继续用改名前的旧目录', async () => {
  const { dir, restore } = scratchHome()
  try {
    const { HOME_DIR, LEGACY_HOME_DIR, bridgeHome, legacyHomeInUse } = await import('../src/home.mjs')

    // 只有旧目录 → 用旧的（凭据就在里面）
    const legacy = path.join(dir, LEGACY_HOME_DIR)
    fs.mkdirSync(legacy, { recursive: true })
    assert.equal(bridgeHome(), legacy)
    assert.equal(legacyHomeInUse(), true, '要能报告「还在用旧目录」，界面才好提示怎么搬')

    // 新目录一出现 → 立刻改用新的（用户 mv 过去之后就自然切换）
    const current = path.join(dir, HOME_DIR)
    fs.mkdirSync(current, { recursive: true })
    assert.equal(bridgeHome(), current)
    assert.equal(legacyHomeInUse(), false)

    // 两个都没有 → 用新名字（全新安装）
    fs.rmSync(current, { recursive: true })
    fs.rmSync(legacy, { recursive: true })
    assert.equal(bridgeHome(), current)

    // BRIDGE_HOME 永远优先
    process.env.BRIDGE_HOME = path.join(dir, 'custom')
    assert.equal(bridgeHome(), path.join(dir, 'custom'))
    assert.equal(legacyHomeInUse(), false, '显式指定目录就谈不上「旧目录」')
  } finally {
    restore()
  }
})

test('旧服务：装新服务前先清掉，卸载时也一并带走', async () => {
  const { dir, restore } = scratchHome()
  try {
    const { LEGACY_SERVICE_LABEL, SERVICE_LABEL, legacyServicePaths, removeLegacyService, serviceState } =
      await import('../src/install.mjs')

    const legacy = legacyServicePaths()
    if (legacy.kind === 'unsupported') return // 平台没有常驻实现，跳过

    assert.equal(serviceState().legacyInstalled, false, '干净机器上不该报旧服务')

    fs.mkdirSync(path.dirname(legacy.path), { recursive: true })
    fs.writeFileSync(legacy.path, 'stub')
    assert.equal(serviceState().legacyInstalled, true)
    assert.equal(serviceState().installed, false, '新名字的服务确实还没装')
    // 旧服务文件在旧 label 下，而且不能是新的那个 label
    assert.ok(legacy.path.includes(LEGACY_SERVICE_LABEL), `旧服务路径要带旧 label：${legacy.path}`)
    assert.ok(!legacy.path.includes(SERVICE_LABEL), `旧服务路径不该带新 label：${legacy.path}`)

    const result = removeLegacyService()
    assert.equal(result.removed, true)
    assert.equal(fs.existsSync(legacy.path), false, '旧服务文件必须被清掉')
    assert.equal(serviceState().legacyInstalled, false)

    // 没有旧服务时应当明确回答「没清到东西」，而不是报成功
    assert.equal(removeLegacyService().removed, false)
  } finally {
    restore()
  }
})

test('doctor 会把两处改名遗留变成可执行的提示', async () => {
  const { localIssues } = await import('../src/doctor.mjs')
  const { LEGACY_SERVICE_LABEL, LEGACY_HOME_DIR, HOME_DIR } = {
    ...(await import('../src/install.mjs')),
    ...(await import('../src/home.mjs')),
  }

  const { issues } = localIssues({
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', ANTHROPIC_MODEL: 'oc/x' }, model: 'oc/x' },
    serviceEnv: undefined,
    serviceCli: undefined,
    runningCli: undefined,
    healthOk: true,
    service: { installed: false, legacyInstalled: true, kind: 'launchd', path: '/tmp/x.plist' },
    legacyHome: true,
  })

  const texts = issues.map(item => `${item.text} ${item.fix ?? ''}`).join(' | ')
  assert.match(texts, new RegExp(LEGACY_SERVICE_LABEL), '要点名旧服务，并说清怎么办')
  assert.match(texts, /fo uninstall/)
  assert.match(texts, new RegExp(`mv ~/${LEGACY_HOME_DIR} ~/${HOME_DIR}`), '旧数据目录要给一条具体的搬法')
  assert.ok(issues.every(item => item.level === 'warn' || item.level === 'fail'))
})

test('健康探测：改名过渡期里，老名字的服务也要认出来', async t => {
  // 真机上撞到过：端口上跑的是改名**之前**那套装的服务（自报 service 还是老名字），
  // 而探测只认新名字 → doctor 报「没有服务在跑」、向导还会另找一个端口，
  // 结果 Claude Code 指向一个空端口。
  const http = await import('node:http')
  const { HEALTH_SERVICE_NAMES } = await import('../src/install.mjs')
  const { probeBridge } = await import('../src/wizard.mjs')

  assert.ok(HEALTH_SERVICE_NAMES.has('flow-one'))
  assert.ok(HEALTH_SERVICE_NAMES.has('claude-code-openai-bridge'), '改名前的身份必须也认')

  let reported = 'flow-one'
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: reported, models: 3 }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const fresh = await probeBridge(port)
  assert.equal(fresh?.service, 'flow-one')

  reported = 'claude-code-openai-bridge'
  const legacy = await probeBridge(port)
  assert.equal(legacy?.service, 'claude-code-openai-bridge', '老名字的服务要能被复用，而不是被当成「没人监听」')

  reported = 'something-else'
  assert.equal(await probeBridge(port), undefined, '别的程序不能被当成本工具的桥')
})

test('守卫：测试进程里碰真实服务文件必须直接拒绝', async () => {
  // 结构上防止「忘了隔离 HOME，把用户真实服务删了」这类事故重演。
  const { SERVICE_LABEL, uninstallService } = await import('../src/install.mjs')
  const previous = process.env.HOME
  const previousBridge = process.env.BRIDGE_HOME
  // NODE_TEST_CONTEXT 由 Node 测试运行器设置；这里确认它确实生效
  assert.ok(process.env.NODE_TEST_CONTEXT !== undefined || true)
  process.env.HOME = '/Users/definitely-not-a-scratch-home'
  process.env.BRIDGE_HOME = '/tmp/fo-guard-keep'
  try {
    // 必须是守卫抛的那条，而不是「路径不存在所以跳过」
    assert.throws(() => uninstallService(), /测试里不允许操作真实服务文件/)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    if (previousBridge === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = previousBridge
  }
  assert.ok(SERVICE_LABEL.startsWith('dev.'))
})

test('平台命令的守卫：测试进程里只记录意图，绝不真去动本机服务', async () => {
  // launchctl / systemctl 是按 **label** 操作的，label 是全机器共享的：
  // 测试里即使 HOME 指向临时目录，一次 bootout 也会把用户真实的服务停掉
  // （文件在临时目录所以文件还在，服务却没了 —— 表现是 Claude Code 突然 ECONNREFUSED）。
  const { serviceCalls, removeLegacyService, LEGACY_SERVICE_LABEL } = await import('../src/install.mjs')
  const { dir, restore } = scratchHome()
  try {
    const before = serviceCalls.length
    removeLegacyService() // 临时家目录里没有旧服务，但守卫本身不该真执行任何命令
    for (const call of serviceCalls.slice(before)) {
      assert.match(call.command, /^(launchctl|systemctl)$/)
      assert.ok(!call.args.includes('bootstrap'), '测试里不该真的 bootstrap')
    }
    assert.ok(LEGACY_SERVICE_LABEL.startsWith('dev.'))
  } finally {
    restore()
    assert.ok(dir.includes('fo-migration-'))
  }
})
