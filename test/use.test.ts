import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `fo use <来源>`：只换渠道。
 *
 * 用户抱怨的是「国内版 / 国际版 / OpenCode 套餐来回换，明明配过了还要重走一遍
 * 一键配置」。这个命令的意义就是**不重走**，所以下面盯住三件事：
 *
 * 1. 切过去用的是**这条线路上次用过的模型**，不是又回到默认；
 * 2. 服务里的挂载清单（`BRIDGE_PRODUCTS`）跟着补齐 —— 少这一步桥会把请求交给旧的
 *    第一条来源，模型名对不上，界面上却看不出任何问题；
 * 3. 客户端配置**只有本来就指向本桥**才回写，别人家的一字节都不碰。
 */

/**
 * 源码这一轮只做了改名，导出还没有类型标注；用例在调用点按实际形状窄化一次，
 * 断言点不变。
 */
type SwitchFns = {
  preferredModel: (input: { models: any[]; lastModels?: any; fallback?: string[] }) => string | undefined
  withSource: (mounted: any, source: any) => string[]
  serviceEnvFor: (input: { env?: any; model?: string; products?: string[] }) => Record<string, any>
  applySwitch: (input: Record<string, unknown>) => Promise<{ written: boolean; service?: any }>
}
type UseFns = {
  modelForSource: (input: { source: any; lastModels?: any; rows?: any[] }) => {
    model?: string
    contextWindow?: number
  }
  mountedIds: (env?: Record<string, unknown>) => string[]
  connectionOf: (input?: { record?: any }) => { port: number; apiKey: string }
  resolveSource: (name: unknown) => { id: string }
  useFlow: (name?: string) => Promise<number>
}
type InstallFns = {
  bridgeRecord: () => any
  recordBridge: (input: Record<string, unknown>) => void
}

/** 每个用例一个隔离的 HOME + BRIDGE_HOME：账本、settings、服务文件都落在临时目录。 */
function scratchHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-use-'))
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    BRIDGE_HOME: process.env.BRIDGE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.HOME = path.join(dir, 'home')
  process.env.USERPROFILE = path.join(dir, 'home')
  process.env.BRIDGE_HOME = path.join(dir, 'home', '.flow-one')
  // Linux 上服务文件在 ${XDG_CONFIG_HOME}/systemd/user 下，只隔离 HOME 拦不住它
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config')
  fs.mkdirSync(process.env.BRIDGE_HOME, { recursive: true })
  fs.mkdirSync(path.join(process.env.HOME, '.claude'), { recursive: true })
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

const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** 造一份「已经配过」的账本；`service` 为 undefined 表示没装常驻。 */
function seedState({ bridge, service }: { bridge: unknown; service?: unknown }) {
  const home = process.env.BRIDGE_HOME as string
  writeJson(path.join(home, 'install.json'), {
    bridge,
    ...(service === undefined ? {} : { service }),
  })
}

function writeSettings(value: unknown) {
  const file = path.join(process.env.HOME as string, '.claude', 'settings.json')
  writeJson(file, value)
  return file
}

test('use：切回某条渠道时用它上次的模型，而不是重新挑一个默认', async () => {
  const { restore } = scratchHome()
  try {
    const { preferredModel } = (await import('../src/switch.ts')) as unknown as Pick<SwitchFns, 'preferredModel'>
    const { modelForSource } = (await import('../src/use.ts')) as unknown as Pick<UseFns, 'modelForSource'>
    const models = [{ id: 'cn/deepseek-v4.1-flash' }, { id: 'cn/glm-5.3' }, { id: 'cn/hy4-preview-f' }]
    // 记过 → 就用记过的那个（哪怕它不是推荐序第一位）
    assert.equal(
      preferredModel({ models, lastModels: { model: 'cn/glm-5.3' }, fallback: ['deepseek-v4.1-flash'] }),
      'cn/glm-5.3',
    )
    // 记过的模型已从清单里消失 → 退回推荐序，而不是给出一个切过去必然找不到的 ID
    assert.equal(preferredModel({ models, lastModels: { model: 'cn/gone' }, fallback: ['glm-5.3'] }), 'cn/glm-5.3')
    // 没记过 → 按推荐序
    assert.equal(
      preferredModel({ models, lastModels: {}, fallback: ['deepseek-v4.1-flash'] }),
      'cn/deepseek-v4.1-flash',
    )
    // 免费档优先：OpenCode 那八十多个模型里先给免费的
    assert.equal(
      preferredModel({
        models: [{ id: 'oc/paid' }, { id: 'oc/free', free: true }],
        lastModels: {},
        fallback: [],
      }),
      'oc/free',
    )

    // 拿不到清单（网络抖）也要能给出答案：退回账本里记过的那个
    const { CN } = await import('../src/products.ts')
    assert.deepEqual(
      modelForSource({ source: CN, lastModels: { cn: { model: 'cn/last-one', contextWindow: 1_000_000 } } }).model,
      'cn/last-one',
      '清单拿不到时不能要求用户去重跑 setup',
    )
    assert.equal(
      modelForSource({ source: CN, lastModels: {} }).model,
      undefined,
      '既没清单也没记录就老实说给不出，而不是瞎编一个模型 ID',
    )
  } finally {
    restore()
  }
})

test('use：服务里的挂载清单跟着补齐，否则桥会把请求交给旧的那条来源', async () => {
  const { restore } = scratchHome()
  try {
    const { CN } = await import('../src/products.ts')
    const { OPENCODE } = await import('../src/opencode.ts')
    const { applySwitch, serviceEnvFor, withSource } = (await import('../src/switch.ts')) as unknown as Pick<
      SwitchFns,
      'applySwitch' | 'serviceEnvFor' | 'withSource'
    >
    const { mountedIds } = (await import('../src/use.ts')) as unknown as Pick<UseFns, 'mountedIds'>

    assert.deepEqual(withSource(['cn'], 'oc'), ['cn', 'oc'], '叠加而不是覆盖')
    assert.deepEqual(withSource(['cn', 'oc'], 'oc'), ['cn', 'oc'], '已经在挂就别重复')
    // 账本里没记过 BRIDGE_PRODUCTS → 与服务启动时的默认一致（全部来源）
    assert.deepEqual(mountedIds({}), ['cn', 'intl', 'oc', 'ocg'])
    assert.deepEqual(mountedIds({ BRIDGE_PRODUCTS: 'cn' }), ['cn'])

    // 服务环境怎么合并是纯函数，单独断言（不去真装服务：installService 在测试进程里
    // 会空跑满 launchd 的重试轮询，二十秒换不来多一条保证）
    const direct = serviceEnvFor({
      env: { BRIDGE_MODE: 'direct', BRIDGE_PRODUCTS: 'cn', OTHER: 'keep' },
      model: 'oc/x',
      products: ['cn', 'oc'],
    })
    assert.equal(direct.BRIDGE_PRODUCTS, 'cn,oc', '这一条就是「切了却用不了」的根因：模型前缀要挂上')
    assert.equal(direct.BRIDGE_MODEL, 'oc/x')
    assert.equal(direct.OTHER, 'keep', '别的服务环境不能被这一刀吃掉')

    // 网关模式：沿用下来的旧清单必须**删掉**，不能只是不写 —— 桥会继续按前缀路由，
    // 而网关的模型 ID 根本没有前缀。也不能落成字符串 "undefined"。
    const gateway = serviceEnvFor({ env: { BRIDGE_MODE: 'gateway', BRIDGE_PRODUCTS: 'cn' }, model: 'workbuddy/x' })
    assert.equal(Object.hasOwn(gateway, 'BRIDGE_PRODUCTS'), false)
    assert.equal(gateway.BRIDGE_MODE, 'gateway')

    seedState({
      bridge: { port: 8788, apiKey: 'k', model: 'cn/x' },
      service: undefined,
    })
    const settings = writeSettings({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'cn/x' },
    })
    const applied = await applySwitch({
      port: 8788,
      apiKey: 'k',
      model: 'oc/deepseek-v4.1-flash-free',
      source: 'oc',
      mounted: ['cn'],
      env: { BRIDGE_MODE: 'direct' },
      settings,
    })
    assert.equal(applied.written, true, '本来就指向本桥的配置必须回写（否则客户端还拿着旧模型）')
    assert.equal(readJson(settings).env.ANTHROPIC_MODEL, 'oc/deepseek-v4.1-flash-free')

    // 防呆：这两个常量确实是「两条不同的渠道」，用例不是在同一条上自证
    assert.notEqual(CN.id, OPENCODE.id)
  } finally {
    restore()
  }
})

test('use：不碰不属于本桥的客户端配置', async () => {
  const { restore } = scratchHome()
  try {
    const { applySwitch } = (await import('../src/switch.ts')) as unknown as Pick<SwitchFns, 'applySwitch'>
    seedState({ bridge: { port: 8788, apiKey: 'k', model: 'cn/x' } })
    // 用户自己指向别家网关的配置
    const settings = writeSettings({
      env: { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_MODEL: 'claude-sonnet-4-5' },
    })
    const before = fs.readFileSync(settings, 'utf8')
    const applied = await applySwitch({
      port: 8788,
      apiKey: 'k',
      model: 'oc/y',
      source: 'oc',
      mounted: ['cn'],
      env: {},
      settings,
    })
    assert.equal(applied.written, false)
    assert.equal(fs.readFileSync(settings, 'utf8'), before, '别人的配置一个字节都不能动')
  } finally {
    restore()
  }
})

test('use：没配过（账本里没有端口）时给出去重跑 setup 的提示，而不是装一个随机端口的服务', async () => {
  const { restore } = scratchHome()
  try {
    const { connectionOf } = (await import('../src/use.ts')) as unknown as Pick<UseFns, 'connectionOf'>
    const { asBridgeError } = await import('../src/errors.ts')
    let thrown
    try {
      connectionOf({ record: {} })
    } catch (error) {
      thrown = error
    }
    const typed = asBridgeError(thrown)
    assert.ok(typed !== undefined, '边界上必须是类型化错误，脚本才分得了支')
    assert.equal(typed.category, 'config')
    assert.equal(typed.subtype, 'settings_missing')
    assert.match(typed.hint, /fo setup/, 'hint 要给可执行的动作')
    // 有账本时读到的就是它
    assert.deepEqual(connectionOf({ record: { port: 9000, apiKey: 'kk' } }), { port: 9000, apiKey: 'kk' })
  } finally {
    restore()
  }
})

test('use：账本按来源记住模型，setup 那条调用不改也要记得下来', async () => {
  const { restore } = scratchHome()
  try {
    const { bridgeRecord, recordBridge } = (await import('../src/install.ts')) as unknown as InstallFns
    // setup 不给 source：从字面前缀推导
    recordBridge({ port: 8788, apiKey: 'k', model: 'intl/glm-5.3', contextWindow: 200_000 })
    assert.deepEqual(bridgeRecord().lastModels.intl, { model: 'intl/glm-5.3', contextWindow: 200_000 })
    // 再切一条：前一条的记录不能被冲掉，否则切回去又要重挑
    recordBridge({ port: 8788, apiKey: 'k', model: 'oc/big-pickle', source: 'oc' })
    assert.equal(bridgeRecord().lastModels.intl.model, 'intl/glm-5.3')
    assert.equal(bridgeRecord().lastModels.oc.model, 'oc/big-pickle')
    // 网关的 workbuddy/x 里那个 workbuddy 是国际版别名，不能被错记成国际版的模型
    recordBridge({ port: 8788, apiKey: 'k', model: 'workbuddy/deepseek-v4.1-flash' })
    assert.equal(bridgeRecord().lastModels.intl.model, 'intl/glm-5.3', '只认字面前缀 cn/intl/oc/ocg')
    // [1m] 后缀不落进历史（那是客户端标记，不是上游模型 ID 的一部分）
    recordBridge({ port: 8788, apiKey: 'k', model: 'cn/x[1m]', contextWindow: 1_000_000 })
    assert.equal(bridgeRecord().lastModels.cn.model, 'cn/x')
    assert.equal(bridgeRecord().model, 'cn/x[1m]', '当前模型仍带后缀，客户端靠它登记 1M 窗口')
  } finally {
    restore()
  }
})

test('use 是正式子命令：带参数能解析，不带参数不静默成功', async () => {
  const { restore } = scratchHome()
  try {
    const { resolveConfig } = (await import('../src/config.ts')) as unknown as {
      resolveConfig: (input: { env?: Record<string, string | undefined>; argv?: string[] }) => {
        command: string
        commandArgs: string[]
      }
    }
    const parsed = resolveConfig({ env: {}, argv: ['use', 'intl'] })
    assert.equal(parsed.command, 'use')
    assert.deepEqual(parsed.commandArgs, ['intl'], '渠道名要传到命令里，不能丢掉')
    // 拼错了子命令就该报错，而不是被当成 serve 起个服务
    assert.throws(() => resolveConfig({ env: {}, argv: ['us', 'intl'] }), /unknown subcommand/)

    const { useFlow } = (await import('../src/use.ts')) as unknown as Pick<UseFns, 'useFlow'>
    const { asBridgeError } = await import('../src/errors.ts')
    let thrown
    try {
      await useFlow(undefined)
    } catch (error) {
      thrown = error
    }
    const typed = asBridgeError(thrown)
    assert.equal(typed?.category, 'validation')
    assert.equal(typed?.param, 'use')
    assert.match(typed.hint, /cn/, 'hint 要列出可选的渠道')
  } finally {
    restore()
  }
})

test('use：别名与大小写都认，未知名字不静默回退', async () => {
  const { restore } = scratchHome()
  try {
    const { resolveSource } = (await import('../src/use.ts')) as unknown as Pick<UseFns, 'resolveSource'>
    const { asBridgeError } = await import('../src/errors.ts')
    // 用户在中文里说的是「国际版」，命令里敲 intl 或 workbuddy 都该认
    assert.equal(resolveSource('intl').id, 'intl')
    assert.equal(resolveSource('国内版').id, 'cn')
    assert.equal(resolveSource(' OC ').id, 'oc')
    assert.equal(resolveSource('go套餐').id, 'ocg')
    let thrown
    try {
      resolveSource('gemini')
    } catch (error) {
      thrown = error
    }
    // 「我说的是 gemini，结果切到了 cn」比报错难查得多
    assert.equal(asBridgeError(thrown)?.category, 'validation')
    assert.equal(asBridgeError(thrown)?.subtype, 'unknown_source')
  } finally {
    restore()
  }
})
