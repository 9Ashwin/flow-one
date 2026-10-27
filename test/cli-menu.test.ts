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
    setTimeout(() => input.emit('keypress', '4', { name: '4' }), 400);
    setTimeout(() => input.write('q\\n'), 800);
    await import(${JSON.stringify(cli)});
  `
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env,
    timeout: 4000,
  })
  assert.match(stderr, /ledger records no port/)
  assert.match(stdout, /操作未完成，已返回主菜单/)
  assert.match(stdout, /顺序：intl\/deepseek-v4\.1-flash → cn\/deepseek-v4\.1-flash → ocg\/deepseek-v4\.1-flash/)
  assert.equal((stdout.match(/请选择要做什么/g) ?? []).length, 2)
})

test('auto 应启用已保存顺序并支持调整、添加和移除候选项，状态页等待用户返回', { timeout: 8000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-menu-auto-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bridge = path.join(home, 'bridge')
  const claude = path.join(home, 'claude')
  fs.mkdirSync(bridge)
  fs.mkdirSync(claude)
  const models = 'intl/model-a,cn/model-b,ocg/model-c'
  fs.writeFileSync(
    path.join(bridge, 'install.json'),
    JSON.stringify({
      bridge: {
        port: 18888,
        apiKey: 'test-key',
        model: 'cn/model-b',
        savedAt: '2026-01-01',
        serviceEnv: { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'cn', BRIDGE_FALLBACK_MODELS: models },
      },
    }),
  )
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888' } }),
  )
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('BRIDGE_') || key.startsWith('UPSTREAM_')) delete env[key]
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    BRIDGE_HOME: bridge,
    CLAUDE_CONFIG_DIR: claude,
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
    setTimeout(() => input.emit('keypress', '1', { name: '1' }), 400);
    setTimeout(() => input.emit('keypress', '1', { name: '1' }), 650);
    setTimeout(() => input.write('1\\n'), 950);
    setTimeout(() => input.emit('keypress', '1', { name: '1' }), 1200);
    setTimeout(() => input.emit('keypress', '2', { name: '2' }), 1450);
    setTimeout(() => input.write('1,1\\n'), 1700);
    setTimeout(() => input.write('3,1,4\\n'), 1950);
    setTimeout(() => input.write('4\\n'), 2250);
    setTimeout(() => input.write('\\n'), 2550);
    setTimeout(() => input.write('q\\n'), 2850);
    await import(${JSON.stringify(cli)});
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env,
    timeout: 7000,
  })
  assert.match(stdout, /自动回退（auto）/)
  assert.match(stdout, /顺序：intl\/model-a → cn\/model-b → ocg\/model-c/)
  assert.match(stdout, /编号不能重复/)
  assert.match(stdout, /回退顺序.*ocg\/model-c → intl\/model-a → oc\/deepseek-v4\.1-flash-free/)
  assert.match(stdout, /请求日志.*前台运行时显示在终端/)
  assert.match(stdout, /按回车返回主菜单/)
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(bridge, 'install.json'), 'utf8'))
  assert.equal(settings.model, 'auto')
  assert.equal(state.bridge.serviceEnv.BRIDGE_FALLBACK_MODELS, 'ocg/model-c,intl/model-a,oc/deepseek-v4.1-flash-free')
})
