import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'

test('Go 模型选择器付费模型应排在免费模型之前，其他渠道保留免费优先', { timeout: 5000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-model-order-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    BRIDGE_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    XDG_CONFIG_HOME: home,
  }
  const prompt = new URL('../src/prompt.ts', import.meta.url).href
  const wizard = new URL('../src/wizard.ts', import.meta.url).href
  for (const [source, expected] of [
    ['ocg', 'paid'],
    ['oc', 'free'],
  ] as const) {
    const script = `
      import { PassThrough } from 'node:stream';
      import { setStdinForTest } from ${JSON.stringify(prompt)};
      import { pickModel } from ${JSON.stringify(wizard)};
      const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
      setStdinForTest(input);
      setTimeout(() => input.emit('keypress', '', { name: 'return' }), 100);
      const picked = await pickModel([{id: '${source}/free', free: true}, {id: '${source}/paid', free: false}]);
      console.log('SELECTED=' + picked.id);
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env,
      timeout: 4000,
    })
    assert.ok(
      stdout.indexOf(`${source}/${expected}`) < stdout.indexOf(`${source}/${expected === 'free' ? 'paid' : 'free'}`),
    )
    assert.match(stdout, new RegExp(`SELECTED=${source}/${expected}`))
  }
})

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

test('切换代码工具应保存选择并在重进菜单显示，Codex 未支持时不能选择', { timeout: 5000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-menu-tool-'))
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
    setTimeout(() => input.write('t\\n'), 150);
    setTimeout(() => input.emit('keypress', '4', { name: '4' }), 400);
    setTimeout(() => input.emit('keypress', '2', { name: '2' }), 650);
    setTimeout(() => input.write('q\\n'), 950);
    await import(${JSON.stringify(cli)});
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env,
    timeout: 4000,
  })
  assert.match(stdout, /Codex.*暂未支持 Responses 协议/)
  assert.doesNotMatch(stdout, /Claude Code 和 DSH/)
  assert.match(stdout, /代码工具.*DSH/)
  const state = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'))
  assert.deepEqual(state.clients, ['dsh'])
  assert.equal(state.clientsAsked, true)
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
  assert.doesNotMatch(stdout, /自动回退/)
  assert.equal((stdout.match(/请选择要做什么/g) ?? []).length, 2)
})
