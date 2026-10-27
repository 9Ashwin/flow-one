import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { browserCommand } from '../src/auth.ts'
import { SUBTYPES } from '../src/errors.ts'
import {
  installService,
  serviceCalls,
  serviceCliPath,
  serviceState,
  setServiceRunnerForTest,
  uninstallService,
  windowsTaskXml,
} from '../src/install.ts'

/**
 * Windows 上的回归：登录链接必须整条交给浏览器。
 *
 * 症状（2026-10-22 真机）：`fo login intl` 打印的链接带 `platform=…&state=…&version=…`，
 * 自动打开浏览器后停在缺 `state` 的页面。根因是走 `cmd /c start`，cmd 把 `&` 当成
 * 命令分隔符，URL 在第一个 `&` 处被截断。
 *
 * 这条用例盯的就是「命令不是 cmd」这件事本身：只要有人把它改回 `cmd /c start`，
 * 或者给 URL 丢了引号，这里就红。
 */
test('Windows：打开浏览器不能经过 cmd，否则 & 会把登录链接截断', () => {
  const url = 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=abc&version=5.5.2&loginSessionId=def'
  const { command, args } = browserCommand(url)

  if (process.platform === 'win32') {
    assert.notEqual(command, 'cmd', 'cmd 会按 & 切命令，链接必然被截断')
    assert.ok(args.includes(url), 'URL 必须整条作为一个参数传出去')
  } else if (process.platform === 'darwin') {
    assert.equal(command, 'open')
    assert.deepEqual(args, [url])
  } else {
    assert.equal(command, 'xdg-open')
    assert.deepEqual(args, [url])
  }
})

test('SUBTYPES 里 service_unsupported 属于 config 闭集，能用于「平台不支持常驻」', () => {
  // 这条断言盯着错误契约：`--service` 装不上时要报一个已声明的 subtype，
  // 而不是裸 throw（裸抛会让调用方只能靠文本分支）。
  assert.equal(SUBTYPES.SERVICE_UNSUPPORTED, 'service_unsupported')
})

test('Windows 计划任务安装、更新和卸载必须保留配置且不得将口令写入任务定义', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-win-task-'))
  const originalPlatform = process.platform
  const oldHome = process.env.BRIDGE_HOME
  process.env.BRIDGE_HOME = home
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  serviceCalls.length = 0
  let taskXml = ''
  setServiceRunnerForTest((_command, args) => {
    if (args[0] === '/Create')
      taskXml = fs
        .readFileSync(args[args.indexOf('/XML') + 1])
        .subarray(2)
        .toString('utf16le')
    return ''
  })
  t.after(() => {
    setServiceRunnerForTest()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    if (oldHome === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const installed = await installService({ port: 8788, apiKey: 'test-secret', env: { BRIDGE_MODEL: 'auto' } })
  assert.equal(installed.ok, true)
  assert.equal(serviceState().kind, 'windows')
  assert.equal(serviceState().installed, true)
  assert.match(taskXml, /InteractiveToken/)
  assert.match(taskXml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/)
  assert.match(taskXml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/)
  assert.doesNotMatch(taskXml, /test-secret/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'service.json'), 'utf8')).env.BRIDGE_API_KEY, 'test-secret')
  assert.ok(serviceCliPath()?.endsWith('cli.ts'))
  assert.equal((await installService({ port: 8788, apiKey: 'test-secret', env: { BRIDGE_MODEL: 'ocg/new' } })).ok, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'service.json'), 'utf8')).env.BRIDGE_MODEL, 'ocg/new')
  const configFile = path.join(home, 'service.json')
  const saved = fs.readFileSync(configFile, 'utf8')
  const fixture = path.join(home, 'fake-cli.cjs')
  fs.writeFileSync(fixture, "process.stderr.write('model=' + process.env.BRIDGE_MODEL)")
  fs.writeFileSync(
    configFile,
    JSON.stringify({ node: process.execPath, cli: fixture, env: { BRIDGE_MODEL: 'ocg/new' } }),
  )
  const run = spawnSync(process.execPath, [path.join(home, 'service-runner.cjs')], { timeout: 5000 })
  assert.equal(run.status, 0, run.stderr?.toString())
  assert.match(fs.readFileSync(path.join(home, 'bridge.err.log'), 'utf8'), /model=ocg\/new/)
  fs.writeFileSync(configFile, saved)
  assert.ok(serviceCalls.some(call => call.args[0] === '/Run'))
  let failOnce = true
  setServiceRunnerForTest((_command, args) => {
    if (args[0] === '/Run' && failOnce) {
      failOnce = false
      throw new Error('simulated start failure')
    }
    return ''
  })
  const failed = await installService({ port: 8788, apiKey: 'changed', env: { BRIDGE_MODEL: 'cn/new' } })
  assert.equal(failed.ok, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'service.json'), 'utf8')).env.BRIDGE_MODEL, 'ocg/new')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).service.env.BRIDGE_MODEL, 'ocg/new')
  setServiceRunnerForTest((_command, args) => {
    if (args[0] === '/Delete') throw new Error('simulated deletion failure')
    return ''
  })
  assert.equal(uninstallService().ok, false)
  assert.equal(fs.existsSync(path.join(home, 'service.json')), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).service.kind, 'windows')
  setServiceRunnerForTest(() => '')
  assert.equal(uninstallService().ok, true)
  assert.ok(serviceCalls.some(call => call.args[0] === '/Delete'))
  assert.equal(fs.existsSync(path.join(home, 'service.json')), false)
})

test('Windows 任务 XML 必须转义用户和含空格的启动路径', () => {
  const xml = windowsTaskXml({
    node: 'C:\\Program Files\\Node & Co\\node.exe',
    runner: 'C:\\Users\\me\\service-runner.cjs',
    user: 'DOM\\A&B',
  })
  assert.match(xml, /Node &amp; Co/)
  assert.match(xml, /DOM\\A&amp;B/)
  assert.match(xml, /<Arguments>"C:\\Users\\me\\service-runner.cjs"<\/Arguments>/)
})
