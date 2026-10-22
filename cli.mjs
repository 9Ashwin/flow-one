#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 四种用法：直接跑（起反代）、`login`（登录国内版 / 国际版）、`status`（看登录
 * 状态）、`models`（列可用模型 ID）。登录与反代共用同一份凭据文件，所以
 * `login` 之后 `ANTHROPIC_MODEL` 填什么，`models` 里就能照抄。
 */

import process from 'node:process'
import { createRequire } from 'node:module'
import {
  SUBTYPES, authError, configError, exitCodeFor, renderError, toBridgeError, upstreamError, validationError,
} from './src/errors.mjs'
import { USAGE, resolveConfig } from './src/config.mjs'
import { credentialStatus, login } from './src/auth.mjs'
import { productByName } from './src/products.mjs'
import { needsLogin } from './src/sources.mjs'
import { hasGoCredential } from './src/opencode.mjs'
import { createDirectUpstream, createGatewayUpstream } from './src/upstreams.mjs'
import { createBridgeServer } from './src/server.mjs'
import { isInteractive, note, style } from './src/prompt.mjs'
import { installService, serviceState } from './src/install.mjs'
import { clientFlow, doctorFlow, mainMenu, setupWizard, statusFlow, switchModel, uninstallFlow } from './src/wizard.mjs'

/**
 * 进度、告警一律走 stderr —— stdout 只放成功数据（AGENTS.md「输出分工」）。
 * 日志混进 stdout，`fo models | jq` 就会拿到一锅粥。
 */
function makeLogger(quiet) {
  return message => { if (!quiet) process.stderr.write(`${message}\n`) }
}

/** 成功数据（模型清单、status 报告）走 stdout，脚本可以直接接管道解析。 */
function makeDataWriter(quiet) {
  return message => { if (!quiet) process.stdout.write(`${message}\n`) }
}

/** 子命令 `login` 支持只登一条产品线：`login cn` / `login intl`。 */
function productsFor(commandArgs, config) {
  if (commandArgs.length === 0) return config.products
  const picked = []
  for (const name of commandArgs) {
    const product = productByName(name)
    if (product === undefined) {
      throw validationError(SUBTYPES.UNKNOWN_SOURCE, `未知产品：${name}`).withHint('可选 cn / intl')
    }
    if (!picked.includes(product)) picked.push(product)
  }
  return picked
}

function makeUpstream(config, log) {
  if (config.mode === 'gateway') return createGatewayUpstream(config)
  return createDirectUpstream(config, { log })
}

function formatExpiry(status) {
  if (status.expiresAt === undefined) return '有效期未知（以服务端为准）'
  const left = status.expiresInMs
  const when = new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })
  if (left === undefined) return when
  const hours = Math.floor(left / 3_600_000)
  const tail = hours >= 48 ? `${Math.floor(hours / 24)} 天后` : `${Math.max(0, hours)} 小时后`
  return `${when}（${left <= 0 ? '已过期' : tail}）`
}

async function commandLogin(config, commandArgs, log) {
  for (const product of productsFor(commandArgs, config)) {
    await login(product, { log, file: config.credentialFile })
  }
  log('\n登录完成。可用模型 ID 见：flow-one models')
}

async function commandStatus(config, out) {
  let any = false
  for (const product of config.products) {
    // 免费档本来就不需要登录，按「未登录」报会让人去跑一条根本不存在的
    // `login oc`（`productByName` 只认 cn / intl，必然报「未知产品」）。
    // 真实踩过（2026-10-16）：用户照着这行去排查，以为免费档没配好，
    // 实际是后台服务压根没起来 —— 这条假线索把方向带偏了。
    if (!needsLogin(product)) {
      out(`${product.id.padEnd(5)} ${product.label}：${product.hint ?? '无需登录'}`)
      any = true
      continue
    }
    // Go 套餐要的是 key，不是登录态，而且凭据存在 `opencode-go` 条目下、不是
    // `ocg` —— 拿 credentialStatus 按 id 去读必然读空，配好了也照样报「未登录」，
    // 再补一句根本不存在的 `login ocg`。同一个坑的另一半，用向导里已有的判据。
    if (product.auth === 'key') {
      const configured = hasGoCredential()
      out(`${product.id.padEnd(5)} ${product.label}：${configured ? '已配 key' : '未配 key（在 `fo setup` 里填）'}`)
      if (configured) any = true
      continue
    }
    const status = credentialStatus(product, { file: config.credentialFile })
    if (!status.loggedIn) {
      out(`${product.id.padEnd(5)} ${product.label}：未登录（flow-one login ${product.id}）`)
      continue
    }
    any = true
    out(`${product.id.padEnd(5)} ${product.label}：已登录${status.nickname === '' ? '' : ` · ${status.nickname}`}`)
    out(`      ${formatExpiry(status)}${status.refreshable ? ' · 可静默续期' : ' · 无 refresh token，过期需重新登录'}`)
  }
  out(`\n凭据文件：${config.credentialFile}`)
  // 报告（成功数据）已经发出去了，但一条可用来源都没有：这不是正常结果。
  if (!any) {
    throw authError(SUBTYPES.NOT_LOGGED_IN, '没有任何一条来源可用')
      .withHint('腾讯两条线跑 flow-one login；OpenCode Go 套餐在 fo setup 里填 key')
  }
}

async function commandModels(config, log, out) {
  const upstream = makeUpstream(config, log)
  const rows = await upstream.loadModels()
  if (rows.length === 0) {
    // 一条来源都没给出模型：这是上游的问题，不是「确实没有模型」的正常结果。
    throw upstreamError(SUBTYPES.MODEL_UNAVAILABLE, '没有拿到任何模型')
      .withHint('直连模式先跑 flow-one login；网关模式检查 --upstream 与密钥')
  }
  let current = ''
  for (const row of rows) {
    const product = row.product ?? ''
    if (product !== current) {
      current = product
      if (product !== '') out(`\n[${product}]`)
    }
    const bits = [
      row.contextWindow === undefined ? '' : `窗口 ${row.contextWindow}`,
      row.maxOutputTokens === undefined ? '' : `输出 ${row.maxOutputTokens}`,
      row.supportsImages === true ? '视觉' : '',
      Array.isArray(row.efforts) && row.efforts.length > 0 ? `档位 ${row.efforts.join('/')}` : '',
    ].filter(Boolean)
    out(`  ${row.id}${bits.length === 0 ? '' : `   ${bits.join(' · ')}`}`)
  }
  // 计数是日志不是数据：清单留在 stdout 给脚本，计数走 stderr。
  log(`\n共 ${rows.length} 个模型。`)
}

async function commandServe(config, log) {
  // `--service` 是「装成常驻」的显式表态：装上了就该退出，让后台服务占着端口；
  // 装不上则必须如实报错。之前这里无视这个 flag，一路打印「flow-one 已启动」然后
  // 前台阻塞 —— Windows 上没有 launchd/systemd，进程随启动它的终端消失，
  // 客户端只看到 ECONNREFUSED，而终端上那句话像是成功了（2026-10-22 真机）。
  if (config.service === true) {
    const state = serviceState()
    if (!state.supported) {
      throw configError(
        SUBTYPES.SERVICE_UNSUPPORTED,
        `${process.platform} 上还不支持装成后台常驻（只实现了 launchd / systemd）`,
      ).withHint('前台跑起来：`flow-one`（保持终端开着）；或把它放进开机启动项，'
        + '例如 Windows 的 shell:startup 里放一个执行 `flow-one` 的快捷方式')
    }
    const installed = await installService({
      port: config.port,
      apiKey: config.apiKey,
      env: {
        BRIDGE_MODE: config.mode,
        ...(config.mode === 'gateway'
          ? { UPSTREAM_BASE_URL: config.upstream, ...(config.upstreamKey === '' ? {} : { UPSTREAM_API_KEY: config.upstreamKey }) }
          : { BRIDGE_PRODUCTS: config.products.map(product => product.id).join(',') }),
        ...(config.model === '' ? {} : { BRIDGE_MODEL: config.model }),
      },
    })
    if (!installed.ok) {
      throw configError(SUBTYPES.SERVICE_UNSUPPORTED, `后台服务没装上：${installed.reason}`)
        .withHint('先前台跑起来确认能通：`flow-one`')
    }
    log(`后台服务已装（${installed.kind}）：${installed.path}`)
    for (const line of installed.notes ?? []) log(`  ${line}`)
    log(`  监听：http://${config.host}:${config.port}`)
    return
  }

  const upstream = makeUpstream(config, log)
  const bridge = createBridgeServer({ config, upstream, log })
  const address = await bridge.listen()
  const host = address?.address === '::1' ? '[::1]' : config.host
  const base = `http://${host}:${address.port}`
  log(`flow-one 已启动`)
  log(`  上游：${upstream.describe()}`)
  log(`  监听：${base}`)
  if (config.apiKey === '') log('  门禁：未设置（仅监听回环；如需跨机使用请加 --api-key）')
  else log('  门禁：已启用 --api-key / ANTHROPIC_AUTH_TOKEN')

  const rows = await upstream.loadModels().catch(() => [])
  const sample = config.model !== '' ? config.model : rows[0]?.id
  if (sample !== undefined) {
    log('\nClaude Code 这样接（KEY 就是上面的 --api-key，没设的话随便填一个非空值）：')
    log(`  export ANTHROPIC_BASE_URL=${base}`)
    log(`  export ANTHROPIC_AUTH_TOKEN=${config.apiKey === '' ? 'any-non-empty' : config.apiKey}`)
    log(`  export ANTHROPIC_MODEL=${sample}`)
    log(`  export ANTHROPIC_SMALL_FAST_MODEL=${sample}`)
  }
  if (rows.length > 0) {
    log(`\n可用模型 ${rows.length} 个，前几个：`)
    for (const row of rows.slice(0, 6)) log(`  ${row.id}`)
    if (rows.length > 6) log(`  …（完整清单：flow-one models）`)
  }

  const shutdown = () => { void bridge.close().then(() => process.exit(0)) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  void bridge.warm()
}

/**
 * `--json` 只决定**错误**怎么渲染（Go 版里它是 root 的 persistent flag）。
 * 它还没进 config.mjs 的 flag 表，所以先在这里摘掉再交给解析器。
 */
const jsonOut = process.argv.slice(2).includes('--json')

/** 版本号只有 package.json 一处真值：发版时别的地方不用跟着改。 */
const { version } = createRequire(import.meta.url)('./package.json')

async function main() {
  const argv = process.argv.slice(2).filter(argument => argument !== '--json')
  // 版本是元信息：不读凭据、不发网络、不进菜单 —— 装完随手敲一下就该有输出。
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${version}\n`)
    return
  }
  const { help, command, commandArgs, config } = resolveConfig({ argv })
  if (help) {
    process.stdout.write(USAGE)
    return
  }
  const log = makeLogger(config.quiet)
  const out = makeDataWriter(config.quiet)
  if (command === 'setup') return await setupWizard({ service: config.service, clients: config.clients })
  if (command === 'uninstall') return await uninstallFlow()
  if (command === 'switch') return await switchModel()
  if (command === 'doctor') return await doctorFlow()
  if (command === 'login') return await commandLogin(config, commandArgs, log)
  if (command === 'status') return await commandStatus(config, out)
  if (command === 'client') return await clientFlow()
  if (command === 'models') return await commandModels(config, log, out)

  // 裸跑且在终端里 → 进菜单。不带参数又没有 TTY（systemd、launchd、管道）时
  // 直接起服务，脚本与后台服务的行为因此不受菜单影响。
  if (argv.length === 0 && isInteractive()) {
    const chosen = await mainMenu()
    if (chosen !== 'serve') return
    note(style.dim('前台运行中，Ctrl+C 退出'))
  }
  return await commandServe(config, log)
}

// 命令边界：任何失败都在这里收敛成契约错误 → 渲染到 stderr → 用 category 推导退出码。
// 退出码不看 subtype、不看 message（脚本据此分支才可靠）。
main().catch(error => {
  const typed = toBridgeError(error)
  process.stderr.write(renderError(typed, { json: jsonOut }))
  process.exitCode = exitCodeFor(typed.category)
})
