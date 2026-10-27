import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

test('全局 node_modules 安装必须能运行 JS 入口，并让后台服务指向同一份快照', t => {
  const build = new URL('../dist/', import.meta.url)
  if (!fs.existsSync(build)) return t.skip('run make build to test the distribution')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-one-distribution-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'node_modules', 'flow-one')
  fs.mkdirSync(installed, { recursive: true })
  fs.cpSync(build, path.join(installed, 'dist'), { recursive: true })
  fs.copyFileSync(new URL('../package.json', import.meta.url), path.join(installed, 'package.json'))
  const cli = path.join(installed, 'dist', 'cli.js')
  const env = { ...process.env, BRIDGE_HOME: path.join(root, 'home'), HOME: root, USERPROFILE: root }
  assert.match(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env }), /^\d+\.\d+\.\d+/)
  const moduleUrl = pathToFileURL(path.join(installed, 'dist', 'src', 'install.js')).href
  const script = `import { currentCliPath } from ${JSON.stringify(moduleUrl)}; process.stdout.write(currentCliPath())`
  assert.equal(
    fs.realpathSync(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })),
    fs.realpathSync(cli),
  )
})
