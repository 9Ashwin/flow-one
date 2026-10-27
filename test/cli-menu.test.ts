import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'

test('退出主菜单不能启动前台服务，即使服务端口已被占用也应成功退出', { timeout: 5000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-menu-exit-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = (server.address() as AddressInfo).port
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('BRIDGE_') || key.startsWith('UPSTREAM_')) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    BRIDGE_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    BRIDGE_PORT: String(port),
  })
  const prompt = new URL('../src/prompt.ts', import.meta.url).href
  const cli = new URL('../cli.ts', import.meta.url).href
  const script = `
    import { PassThrough } from 'node:stream';
    import { setStdinForTest } from ${JSON.stringify(prompt)};
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    setStdinForTest(input);
    setTimeout(() => input.write('q\\n'), 200);
    await import(${JSON.stringify(cli)});
  `
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env,
    timeout: 4000,
  })
  assert.match(stdout + stderr, /请选择要做什么/)
  assert.doesNotMatch(stdout + stderr, /EADDRINUSE|running in the foreground/)
})

test('切换渠道遇到缺少配置时应回到主菜单，而不是直接退出程序', { timeout: 5000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-menu-retry-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('BRIDGE_') || key.startsWith('UPSTREAM_')) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    BRIDGE_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    XDG_CONFIG_HOME: home,
  })
  const prompt = new URL('../src/prompt.ts', import.meta.url).href
  const cli = new URL('../cli.ts', import.meta.url).href
  const script = `
    import { PassThrough } from 'node:stream';
    import { setStdinForTest } from ${JSON.stringify(prompt)};
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    setStdinForTest(input);
    setTimeout(() => input.write('1\\n'), 150);
    setTimeout(() => input.emit('keypress', '3', { name: '3' }), 400);
    setTimeout(() => input.write('q\\n'), 800);
    await import(${JSON.stringify(cli)});
  `
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env,
    timeout: 4000,
  })
  assert.match(stderr, /ledger records no port/)
  assert.match(stdout, /操作未完成，已返回主菜单/)
  assert.equal((stdout.match(/请选择要做什么/g) ?? []).length, 2)
})
