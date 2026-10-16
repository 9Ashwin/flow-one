#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 四种用法：直接跑（起反代）、`login`（登录国内版 / 国际版）、`status`（看登录
 * 状态）、`models`（列可用模型 ID）。登录与反代共用同一份凭据文件，所以
 * `login` 之后 `ANTHROPIC_MODEL` 填什么，`models` 里就能照抄。
 */

import process from 'node:process'
import { USAGE, resolveConfig } from './src/config.mjs'
import { credentialStatus, login } from './src/auth.mjs'
import { productByName } from './src/products.mjs'
import { createDirectUpstream, createGatewayUpstream } from './src/upstreams.mjs'
import { createBridgeServer } from './src/server.mjs'
import { isInteractive, note, style } from './src/prompt.mjs'
import { doctorFlow, mainMenu, setupWizard, statusFlow, switchModel, uninstallFlow } from './src/wizard.mjs'

function makeLogger(quiet) {
  return message => { if (!quiet) process.stdout.write(`${message}\n`) }
}

/** 子命令 `login` 支持只登一条产品线：`login cn` / `login intl`。 */
function productsFor(commandArgs, config) {
  if (commandArgs.length === 0) return config.products
  const picked = []
  for (const name of commandArgs) {
    const product = productByName(name)
    if (product === undefined) throw new Error(`未知产品：${name}（可选 cn / intl）`)
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
  log('\n登录完成。可用模型 ID 见：claude-code-bridge models')
}

async function commandStatus(config, log) {
  let any = false
  for (const product of config.products) {
    const status = credentialStatus(product, { file: config.credentialFile })
    if (!status.loggedIn) {
      log(`${product.id.padEnd(5)} ${product.label}：未登录（claude-code-bridge login ${product.id}）`)
      continue
    }
    any = true
    log(`${product.id.padEnd(5)} ${product.label}：已登录${status.nickname === '' ? '' : ` · ${status.nickname}`}`)
    log(`      ${formatExpiry(status)}${status.refreshable ? ' · 可静默续期' : ' · 无 refresh token，过期需重新登录'}`)
  }
  log(`\n凭据文件：${config.credentialFile}`)
  if (!any) process.exitCode = 1
}

async function commandModels(config, log) {
  const upstream = makeUpstream(config, log)
  const rows = await upstream.loadModels()
  if (rows.length === 0) {
    log('没有拿到任何模型。直连模式请先 login；网关模式请检查 --upstream 与密钥。')
    process.exitCode = 1
    return
  }
  let current = ''
  for (const row of rows) {
    const product = row.product ?? ''
    if (product !== current) {
      current = product
      if (product !== '') log(`\n[${product}]`)
    }
    const bits = [
      row.contextWindow === undefined ? '' : `窗口 ${row.contextWindow}`,
      row.maxOutputTokens === undefined ? '' : `输出 ${row.maxOutputTokens}`,
      row.supportsImages === true ? '视觉' : '',
      Array.isArray(row.efforts) && row.efforts.length > 0 ? `档位 ${row.efforts.join('/')}` : '',
    ].filter(Boolean)
    log(`  ${row.id}${bits.length === 0 ? '' : `   ${bits.join(' · ')}`}`)
  }
  log(`\n共 ${rows.length} 个模型。`)
}

async function commandServe(config, log) {
  const upstream = makeUpstream(config, log)
  const bridge = createBridgeServer({ config, upstream, log })
  const address = await bridge.listen()
  const host = address?.address === '::1' ? '[::1]' : config.host
  const base = `http://${host}:${address.port}`
  log(`claude-code-openai-bridge 已启动`)
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
    if (rows.length > 6) log(`  …（完整清单：claude-code-bridge models）`)
  }

  const shutdown = () => { void bridge.close().then(() => process.exit(0)) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  void bridge.warm()
}

async function main() {
  const argv = process.argv.slice(2)
  const { help, command, commandArgs, config } = resolveConfig({ argv })
  if (help) {
    process.stdout.write(USAGE)
    return
  }
  const log = makeLogger(config.quiet)
  if (command === 'setup') return await setupWizard()
  if (command === 'uninstall') return await uninstallFlow()
  if (command === 'switch') return await switchModel()
  if (command === 'doctor') return await doctorFlow()
  if (command === 'login') return await commandLogin(config, commandArgs, log)
  if (command === 'status') return await commandStatus(config, log)
  if (command === 'models') return await commandModels(config, log)

  // 裸跑且在终端里 → 进菜单。不带参数又没有 TTY（systemd、launchd、管道）时
  // 直接起服务，脚本与后台服务的行为因此不受菜单影响。
  if (argv.length === 0 && isInteractive()) {
    const chosen = await mainMenu()
    if (chosen !== 'serve') return
    note(style.dim('前台运行中，Ctrl+C 退出'))
  }
  return await commandServe(config, log)
}

main().catch(error => {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exitCode = 1
})
