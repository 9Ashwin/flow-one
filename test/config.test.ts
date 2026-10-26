import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 命令行开关的解析。这些是**脚本化使用**的入口（`--json` 给管道、`--service` 给无人值守安装），
 * 之前它们根本不被认识，会在解析层抛「unknown option」。
 */

/**
 * `json` / `service` 是解析过程中才补上的字段，源码用 JSDoc 表达类型时还没声明；
 * 这里按真实用法收窄一次，断言点不变。
 */
type Resolved = {
  config: { json?: boolean; service?: boolean }
  command: string
  commandArgs: string[]
}
type ResolveConfig = (options: { env?: Record<string, string | undefined>; argv?: string[] }) => Resolved
/** 契约错误的判据字段（同 errors.ts），用例要断言它们。 */
type TypedError = { category: string; param: string }

test('--json 被解析器认识，并且不吞掉后面的子命令', async () => {
  const { resolveConfig } = (await import('../src/config.ts')) as unknown as { resolveConfig: ResolveConfig }
  const { config, command } = resolveConfig({ env: {}, argv: ['status', '--json'] })
  assert.equal(config.json, true)
  assert.equal(command, 'status')
})

test('--service / --no-service 表示「显式表态」，没给时是 undefined', async () => {
  const { resolveConfig } = (await import('../src/config.ts')) as unknown as { resolveConfig: ResolveConfig }
  assert.equal(resolveConfig({ env: {}, argv: ['setup', '--service'] }).config.service, true)
  assert.equal(resolveConfig({ env: {}, argv: ['setup', '--no-service'] }).config.service, false)
  // 没表态必须是 undefined 而不是 false：向导要靠它区分「用户拒绝过」与「还没问过」
  assert.equal(resolveConfig({ env: {}, argv: ['setup'] }).config.service, undefined)
})

test('--help 的用法里列出了脚本化要用的开关', async () => {
  const { USAGE } = await import('../src/config.ts')
  for (const flag of ['--json', '--service', '--no-service', '--version']) {
    assert.ok(USAGE.includes(flag), `--help 里应当列出 ${flag}`)
  }
})

test('不认识的开关仍然明确报错（别把打错的 flag 静默忽略）', async () => {
  const { resolveConfig } = (await import('../src/config.ts')) as unknown as { resolveConfig: ResolveConfig }
  assert.throws(() => resolveConfig({ env: {}, argv: ['serve', '--nope'] }), /unknown option/)
})

test('非回环监听拒绝空/空白/公开默认 key，回环与自定义 key 保持兼容', async () => {
  const { validateListenAuth, DEFAULT_LOCAL_API_KEY, resolveConfig } =
    (await import('../src/config.ts')) as unknown as {
      validateListenAuth: (options: { host?: string; apiKey?: string }) => void
      DEFAULT_LOCAL_API_KEY: string
      resolveConfig: ResolveConfig
    }
  for (const host of ['0.0.0.0', '::', '192.168.1.2', 'localhost', 'example.invalid', undefined, '::ffff:127.0.0.1']) {
    for (const apiKey of ['', '  ', undefined, DEFAULT_LOCAL_API_KEY, ` ${DEFAULT_LOCAL_API_KEY} `]) {
      assert.throws(
        () => validateListenAuth({ host, apiKey }),
        (error: TypedError) => {
          assert.equal(error.category, 'validation')
          assert.equal(error.param, '--api-key')
          return true
        },
      )
    }
    assert.doesNotThrow(() => validateListenAuth({ host, apiKey: 'custom-test-key' }))
  }
  for (const host of ['127.0.0.1', '127.12.34.56', '::1', '0:0:0:0:0:0:0:1']) {
    for (const apiKey of ['', DEFAULT_LOCAL_API_KEY]) assert.doesNotThrow(() => validateListenAuth({ host, apiKey }))
  }
  assert.throws(() => resolveConfig({ env: {}, argv: ['--host', '0.0.0.0'] }), /non-loopback/)
  assert.throws(
    () => resolveConfig({ env: { BRIDGE_HOST: '::', BRIDGE_API_KEY: DEFAULT_LOCAL_API_KEY }, argv: [] }),
    /non-loopback/,
  )
})
