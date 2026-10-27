import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BridgeError,
  CATEGORIES,
  SUBTYPES,
  asBridgeError,
  authError,
  envelope,
  exitCodeFor,
  internalFrom,
  isDeclaredSubtype,
  networkError,
  renderError,
  toBridgeError,
  upstreamError,
  validationError,
} from '../src/errors.ts'

// 契约本身是这些用例的验收标准（AGENTS.md「错误契约」）：字段名与取值是给脚本用的，
// 改了就破坏兼容，所以这里连格式一起钉住。

/** 跑一次真 CLI：这几条断言的是 stdout / stderr 的分工与退出码，不是内部函数。 */
type CliResult = { code: number | null; stdout: string; stderr: string }

test('退出码只由 category 推导：六类各一个码，不看 subtype 也不看 message', () => {
  assert.deepEqual(Object.values(CATEGORIES), ['validation', 'auth', 'config', 'network', 'upstream', 'internal'])
  assert.equal(exitCodeFor(CATEGORIES.VALIDATION), 2)
  assert.equal(exitCodeFor(CATEGORIES.AUTH), 3)
  assert.equal(exitCodeFor(CATEGORIES.CONFIG), 4)
  assert.equal(exitCodeFor(CATEGORIES.NETWORK), 5)
  assert.equal(exitCodeFor(CATEGORIES.UPSTREAM), 6)
  assert.equal(exitCodeFor(CATEGORIES.INTERNAL), 1)
  // 同一个 category 下 subtype / code / message 怎么变都不影响退出码
  assert.equal(exitCodeFor(upstreamError(SUBTYPES.CONTENT_BLOCKED, '请求被拦截').withCode(11128).category), 6)
  assert.equal(exitCodeFor(upstreamError(SUBTYPES.QUOTA_LIMITED, '额度用完了').category), 6)
  assert.equal(exitCodeFor(authError(SUBTYPES.NOT_LOGGED_IN, '没登录').category), 3)
  // 闭集外的分类退化成 1，而不是 NaN 或 undefined
  assert.equal(exitCodeFor('nonsense'), 1)
})

test('信封：字段名固定，没给的 code / param / hint 就不出现', () => {
  assert.deepEqual(envelope(validationError(SUBTYPES.INVALID_PORT, '端口不合法')), {
    ok: false,
    error: { type: 'validation', subtype: 'invalid_port', message: '端口不合法' },
  })
  assert.deepEqual(
    envelope(
      upstreamError(SUBTYPES.CONTENT_BLOCKED, '请求被拦截')
        .withCode(11128)
        .withParam('--model')
        .withHint('换个说法再试'),
    ),
    {
      ok: false,
      error: {
        type: 'upstream',
        subtype: 'content_blocked',
        code: 11128,
        param: '--model',
        hint: '换个说法再试',
        message: '请求被拦截',
      },
    },
  )
  // 上游码是数字：脚本会拿它跟 HTTP 状态码 / 腾讯码比大小、查表
  const badStatus = envelope(upstreamError(SUBTYPES.BAD_STATUS, '上游拒绝').withCode(429)).error as unknown as {
    code: number
  }
  assert.equal(typeof badStatus.code, 'number')
  // 顺序与 Go 版一致，消费方按行读时不用猜键序
  assert.equal(
    JSON.stringify(envelope(networkError(SUBTYPES.TIMEOUT, '读流超时').withCode(504).withHint('重试'))),
    '{"ok":false,"error":{"type":"network","subtype":"timeout","code":504,"hint":"重试","message":"读流超时"}}',
  )
})

test('hint 另起一行：人读输出要么两行要么一行，修法不许进 message', () => {
  assert.equal(
    renderError(validationError(SUBTYPES.INVALID_PORT, '端口不合法').withHint('用 --port 指定一个空闲端口')),
    'Error: 端口不合法\n  → 用 --port 指定一个空闲端口\n',
  )
  assert.equal(renderError(networkError(SUBTYPES.CONNECT_FAILED, '连不上网关')), 'Error: 连不上网关\n')
  // message 空了也要有得看，不能渲染出一行光秃秃的 `Error: `
  assert.equal(renderError(new BridgeError(CATEGORIES.INTERNAL, SUBTYPES.IO_FAILED, '')), 'Error: internal/io_failed\n')
})

test('subtype 是闭集：拼错的名字在构造期就抛，不能等线上才暴露', () => {
  assert.equal(isDeclaredSubtype(SUBTYPES.INVALID_PORT), true)
  assert.equal(isDeclaredSubtype('invalid_portt'), false)
  // 故意传闭集外的 subtype：构造期必须抛，所以这里绕开类型检查（用例本身就是那条防线）。
  assert.throws(() => validationError('invalid_portt' as never, '端口不合法'), /undeclared subtype/)
  assert.throws(() => new BridgeError(CATEGORIES.VALIDATION, 'InvalidPort', '端口不合法'), /undeclared subtype/)
  // 闭集外的 category 同样当场抛：否则退出码会静默退化成 1
  assert.throws(() => new BridgeError('oops', SUBTYPES.INVALID_PORT, '端口不合法'), /undeclared category/)
  // 消费方按 subtype 分支，格式（小写下划线）漂了就是破坏兼容
  for (const value of Object.values(SUBTYPES)) assert.match(value, /^[a-z][a-z0-9_]*$/)
})

test('未预期的异常落进 internal：原始堆栈不吞，已类型化的不重复包装', () => {
  const raw = new Error('socket hang up')
  const typed = toBridgeError(raw)
  assert.equal(typed.category, CATEGORIES.INTERNAL)
  assert.equal(typed.subtype, SUBTYPES.UNEXPECTED)
  assert.equal(typed.cause, raw, '原因链要能拿回原始异常')
  assert.match(typed.message, /socket hang up/)
  assert.equal(exitCodeFor(typed.category), 1)
  assert.ok(renderError(typed).includes(raw.stack as string), '没被类型化的异常必须把堆栈带出来，否则只能靠猜')
  // 包装幂等：套第二层会让调用方拿到信息更少的外层
  assert.equal(toBridgeError(typed), typed)
  assert.equal(internalFrom(typed), typed)
  assert.equal(asBridgeError(typed), typed)
  assert.equal(asBridgeError(raw), undefined)
  // 非 Error 的抛出物（throw 'boom' / throw undefined）也要有可读输出，而不是崩在渲染里
  assert.match(renderError(toBridgeError('boom')), /internal error: boom/)
  assert.match(renderError(toBridgeError(undefined)), /internal error: undefined/)
})

/** 跑一次真 CLI：这几条断言的是 stdout / stderr 的分工与退出码，不是内部函数。 */
function runCli(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-errors-'))
  const cli = fileURLToPath(new URL('../cli.ts', import.meta.url))
  // 本机导出的 BRIDGE_* / UPSTREAM_* 会改变解析结果（例如 BRIDGE_MODE=gateway），
  // 清掉才可复现；BRIDGE_HOME 指到临时目录，绝不碰真实家目录。
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: home,
    XDG_CONFIG_HOME: home,
    BRIDGE_HOME: home,
  }
  for (const key of Object.keys(env)) {
    if (key !== 'BRIDGE_HOME' && (key.startsWith('BRIDGE_') || key.startsWith('UPSTREAM_'))) delete env[key]
  }
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  return new Promise<CliResult>(resolve => child.on('exit', code => resolve({ code, stdout, stderr })))
}

test('--json：stderr 恰好一行信封、stdout 一个字节都没有', async () => {
  const { code, stdout, stderr } = await runCli(['login', 'zz', '--json'])
  assert.equal(code, 2, `未知产品该是 validation 的退出码 2，实际 ${code}（stderr：${stderr}）`)
  assert.equal(stdout, '', '错误进了 stdout，`fo models --as-json | jq` 就会被污染')
  const lines = stderr.split('\n').filter(line => line !== '')
  assert.equal(lines.length, 1, `--json 只该有一行信封，实际 ${lines.length} 行：${stderr}`)
  assert.deepEqual(JSON.parse(lines[0]), {
    ok: false,
    error: {
      type: 'validation',
      subtype: 'unknown_source',
      hint: 'expected cn / intl',
      message: 'unknown product: zz',
    },
  })
})

test('默认人读：Error 与 hint 两行走 stderr，stdout 保持干净', async () => {
  const { code, stdout, stderr } = await runCli(['login', 'zz'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.equal(stderr, 'Error: unknown product: zz\n  → expected cn / intl\n')
})

test('--json 只管错误：成功路径的 stdout 照旧、stderr 空着', async () => {
  const { code, stdout, stderr } = await runCli(['--help', '--json'])
  assert.equal(code, 0)
  assert.match(stdout, /^Usage:/m)
  assert.equal(stderr, '', '没有错误就不该出现信封')
})

test('未配置时 fo client 必须返回 config 错误，而不是打印失败后退出 0', async () => {
  const result = await runCli(['client', '--json'])
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.type, 'config')
  assert.equal(error.subtype, 'settings_missing')
})

test('--version / -v：版本号一行走 stdout、退出码 0，且只有 package.json 一处真值', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const flag of ['--version', '-v']) {
    const { code, stdout, stderr } = await runCli([flag])
    assert.equal(code, 0, `${flag} 是元信息，不是错误`)
    assert.equal(stdout, `${pkg.version}\n`, `${flag} 必须跟 package.json 的 version 一致，且只占 stdout 一行`)
    assert.equal(stderr, '')
  }
})
