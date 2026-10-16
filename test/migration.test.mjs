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
  const previousHome = process.env.HOME
  const previousBridgeHome = process.env.BRIDGE_HOME
  process.env.HOME = dir
  delete process.env.BRIDGE_HOME
  return {
    dir,
    restore() {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousBridgeHome === undefined) delete process.env.BRIDGE_HOME
      else process.env.BRIDGE_HOME = previousBridgeHome
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
