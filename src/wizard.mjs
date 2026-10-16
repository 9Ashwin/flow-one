/**
 * 交互式向导：一条命令把「登录 → 选模型 → 写 Claude Code 配置 → 后台常驻」跑完。
 *
 * 设计上的两个取舍：
 *
 * - **菜单不是万能的**。所有步骤都能用命令行参数完成（`--port`、`--model`……），
 *   向导只是把默认值和顺序摆出来。所以 CI、脚本、systemd 直接跑 `cli.mjs` 不受影响。
 * - **每一步都如实报告**。写哪个文件、备份到哪、服务有没有真的加载起来，都在屏幕上说清楚；
 *   失败时给出可直接复制粘贴的补救命令，而不是一句「配置失败」。
 *
 * @module src/wizard.mjs
 */

import net from 'node:net'
import crypto from 'node:crypto'
import process from 'node:process'
import { CN, INTL } from './products.mjs'
import { login, credentialStatus } from './auth.mjs'
import { createDirectUpstream, createGatewayUpstream } from './upstreams.mjs'
import { credentialFile } from './config.mjs'
import { installClaudeSettings, installService, uninstallClaudeSettings, uninstallService, serviceState, claudeSettingsPath, readInstallState } from './install.mjs'
import { confirm, fail, heading, input, note, rule, select, style, success, warn } from './prompt.mjs'

const { dim, bold, cyan } = style
const DEFAULT_PORT = 8788
/** 面向 Claude Code 的默认候选：这几个是这台机器上实测跑通的。 */
const PREFERRED_MODELS = ['deepseek-v4.1-flash', 'hy4-preview-f', 'deepseek-v4-flash', 'glm-5.3']

function shortNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

function modelHint(row) {
  const bits = []
  if (row.contextWindow !== undefined) bits.push(`窗口 ${shortNumber(row.contextWindow)}`)
  if (row.maxOutputTokens !== undefined) bits.push(`输出 ${shortNumber(row.maxOutputTokens)}`)
  if (Array.isArray(row.efforts) && row.efforts.length > 0) bits.push(`档位 ${row.efforts.join('/')}`)
  if (row.supportsImages === true) bits.push('视觉')
  return bits.join(' · ')
}

/** 端口占用探测：比「先绑再失败」更早给出可用的建议值。 */
async function portAvailable(port) {
  return await new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function suggestPort() {
  for (const port of [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2, 18788, 0]) {
    if (port === 0) return 0
    if (await portAvailable(port)) return port
  }
  return 0
}

/** 健康检查：确认后台服务真的把端口监听起来了，而不是只写了个文件。 */
async function waitHealthy(base, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return await response.json()
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return undefined
}

// ── 登录 ────────────────────────────────────────────────────────────────────

function loginHint(product) {
  const status = credentialStatus(product)
  if (!status.loggedIn) return '未登录'
  return status.nickname === '' ? '已登录' : `已登录 · ${status.nickname}`
}

/** 逐条产品线登录；已登录且用户不想重登的直接跳过。 */
export async function ensureLoggedIn(products, { force = false } = {}) {
  for (const product of products) {
    const status = credentialStatus(product)
    if (status.loggedIn && !force) {
      success(`${product.label}：${status.nickname === '' ? '已登录' : status.nickname}`)
      continue
    }
    heading(`登录 ${product.label}`)
    note(dim('  浏览器会打开授权页面；终端里也会打印链接，SSH 环境下直接复制粘贴即可。'))
    try {
      await login(product, { log: line => note(`  ${line}`) })
    } catch (error) {
      fail(error?.message ?? String(error))
      if (!await confirm({ message: '换一条产品线继续？', initial: true })) throw error
      continue
    }
  }
}

// ── 选模型 ──────────────────────────────────────────────────────────────────

/**
 * 从清单里挑模型。
 *
 * 网关模式动辄几十个模型，一屏放不下也没有滚动，所以给出「前 N 个 + 关键词筛选 +
 * 手动输入」三条路，而不是把 47 行全铺出来。
 */
export async function pickModel(rows, { limit = 12 } = {}) {
  const ranked = [...rows].sort((a, b) => rank(a.id) - rank(b.id))
  const shown = ranked.slice(0, limit)
  const options = shown.map(row => ({
    label: row.id,
    hint: modelHint(row),
    value: row.id,
  }))
  if (ranked.length > shown.length) {
    options.push({ label: '⌕  输入关键词筛选…', hint: `还有 ${ranked.length - shown.length} 个`, value: '__filter__' })
  }
  options.push({ label: '✎  手动输入模型 ID', hint: '适用于清单里没有的模型', value: '__manual__' })

  const picked = await select({ message: '用哪个模型？', options })
  if (picked === '__manual__') {
    return await input({
      message: '模型 ID（Gateway 模式形如 workbuddy/xxx，直连模式形如 cn/xxx）',
      initial: ranked[0]?.id ?? '',
      validate: value => (value === '' ? '不能为空' : undefined),
    })
  }
  if (picked === '__filter__') {
    const keyword = await input({ message: '关键词', initial: 'deepseek' })
    const matched = ranked.filter(row => row.id.toLowerCase().includes(keyword.toLowerCase()))
    if (matched.length === 0) {
      warn(`没有匹配 ${keyword} 的模型`)
      return await pickModel(rows, { limit })
    }
    return await select({
      message: '用哪个模型？',
      options: matched.map(row => ({ label: row.id, hint: modelHint(row), value: row.id })),
    })
  }
  return picked
}

/** 偏好模型排前面，其余保持远端顺序。 */
function rank(id) {
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const at = PREFERRED_MODELS.findIndex(preferred => bare === preferred)
  return at >= 0 ? at : PREFERRED_MODELS.length
}

// ── 一键配置 ────────────────────────────────────────────────────────────────

export async function setupWizard() {
  heading('claude-code-openai-bridge · 一键配置')

  const mode = await select({
    message: '上游用哪种？',
    options: [
      { label: '直连 WorkBuddy（国内版 / 国际版）', hint: '推荐：用自己账号的额度，本工具自己登录', value: 'direct' },
      { label: '转发给已有的 OpenAI 兼容网关', hint: '如 dsh-our-free-model 的 8326、LiteLLM、Ollama', value: 'gateway' },
    ],
  })

  let upstream
  /** 写进后台服务的环境：服务不带参数启动，模式与模型必须由环境说清楚。 */
  const serviceEnv = {}
  if (mode === 'direct') {
    const which = await select({
      message: '装哪几条产品线？',
      options: [
        { label: '国内版 + 国际版', hint: `${loginHint(CN)} / ${loginHint(INTL)}`, value: [CN, INTL] },
        { label: '只要国内版（CodeBuddy）', hint: loginHint(CN), value: [CN] },
        { label: '只要国际版（WorkBuddy）', hint: loginHint(INTL), value: [INTL] },
      ],
    })
    await ensureLoggedIn(which, { force: false })
    upstream = createDirectUpstream({ products: which, credentialFile: credentialFile() }, { log: line => note(`  ${dim(line)}`) })
  } else {
    const base = await input({
      message: '上游地址',
      initial: 'http://127.0.0.1:8326',
      validate: value => {
        try {
          const url = new URL(value)
          return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : '只支持 http/https'
        } catch { return '不是合法的 URL' }
      },
    })
    const key = await input({ message: '上游密钥（没有就直接回车）', initial: '' })
    upstream = createGatewayUpstream({ upstream: base.replace(/\/+$/, ''), upstreamKey: key })
    serviceEnv.BRIDGE_MODE = 'gateway'
    serviceEnv.UPSTREAM_BASE_URL = base.replace(/\/+$/, '')
    if (key !== '') serviceEnv.UPSTREAM_API_KEY = key
  }

  note(`\n${dim('读取模型清单……')}`)
  let rows = []
  try {
    rows = await upstream.loadModels()
  } catch (error) {
    fail(`拿不到模型清单：${error?.message ?? error}`)
  }
  if (rows.length === 0) {
    fail('没有可用模型，先检查登录或上游地址，再重新运行 --setup')
    return 1
  }
  success(`${rows.length} 个模型可用`)
  const model = await pickModel(rows)

  const port = await input({
    message: '本机监听端口',
    initial: String(await suggestPort()),
    validate: value => {
      const number = Number(value)
      return Number.isInteger(number) && number >= 1 && number <= 65535 ? undefined : '端口必须是 1-65535 的整数'
    },
  })
  serviceEnv.BRIDGE_MODEL = model
  const apiKey = crypto.randomBytes(24).toString('base64url')

  heading('写入 Claude Code 配置')
  const settingsFile = claudeSettingsPath()
  note(`  文件：${cyan(settingsFile)}`)
  const applied = installClaudeSettings({ file: settingsFile, baseUrl: `http://127.0.0.1:${port}`, apiKey, model })
  if (applied.backup !== undefined) success(`已备份原文件：${dim(applied.backup)}`)
  success(`已写入 ${Object.keys(applied.env).join('、')}`)

  heading('后台常驻')
  const wantsService = await confirm({ message: '装成开机自启的后台服务？（不装的话每次要自己起）', initial: true })
  let service
  if (wantsService) {
    service = await installService({ port: Number(port), apiKey, env: serviceEnv })
    if (service.ok) success(`已安装（${service.kind}）：${dim(service.path)}`)
    else {
      fail(service.reason)
      warn('可以先用前台方式跑：node cli.mjs')
    }
  } else {
    warn(`没装后台服务。需要时手动跑：BRIDGE_PORT=${port} BRIDGE_API_KEY=${apiKey} node cli.mjs`)
  }

  if (service?.ok === true) {
    note(`\n${dim('等待服务就绪……')}`)
    const health = await waitHealthy(`http://127.0.0.1:${port}`)
    if (health === undefined) {
      warn('12 秒内没等到 /health 应答，看看日志：')
      note(`  ${dim(readInstallState().service?.kind === 'launchd' ? `~/.claude-code-openai-bridge/bridge.err.log` : 'journalctl --user -u dev.claude-code-openai-bridge')}`)
    } else success(`反代已在 http://127.0.0.1:${port} 运行`)
  }

  heading('完成')
  note(`  模型：${bold(model)} ${dim('（按 1M 上下文登记）')}`)
  note(`  现在直接在任意目录运行 ${bold('claude')} 即可。`)
  note(dim('  改配置：重新运行 --setup；还原：--uninstall'))
  rule()
  return 0
}

// ── 其它流程 ────────────────────────────────────────────────────────────────

export async function loginFlow(products) {
  await ensureLoggedIn(products, { force: true })
  return 0
}

export async function statusFlow() {
  heading('状态')
  for (const product of [CN, INTL]) {
    const status = credentialStatus(product)
    const line = status.loggedIn
      ? `${status.nickname === '' ? '已登录' : status.nickname}${status.expiresAt === undefined ? '' : ` · ${new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })}`}`
      : dim('未登录')
    note(`  ${product.id.padEnd(5)} ${product.label}：${line}`)
  }
  const service = serviceState()
  note(`  服务  ${service.installed ? `已安装（${service.kind}）` : '未安装'}${service.installed ? ` ${dim(service.path)}` : ''}`)
  const state = readInstallState().claudeSettings
  note(`  Claude Code 配置  ${state === undefined ? dim('本工具未写入过') : state.file}`)
  rule()
  return 0
}

export async function uninstallFlow() {
  heading('还原')
  const settings = uninstallClaudeSettings()
  if (settings.skipped === true) note(`  Claude Code 配置：${settings.reason}`)
  else success(`已从 ${settings.file} 移除 ${settings.removed.length} 个键（备份见 ${settings.backup}）`)
  const service = uninstallService()
  if (service.skipped === true) note(`  后台服务：${service.reason}`)
  else success(`已卸载后台服务（${service.kind}）`)
  rule()
  return 0
}

/** 主菜单：不给参数又是在终端里跑时进这里。 */
export async function mainMenu() {
  for (;;) {
    heading('claude-code-openai-bridge')
    const service = serviceState()
    note(dim(`  凭据目录 ${readInstallState().claudeSettings?.file ?? '（未写入 Claude Code 配置）'}${service.installed ? `\n  后台服务 ${service.path}` : ''}`))
    const action = await select({
      message: '要做什么？',
      options: [
        { label: '一键配置', hint: '登录 → 选模型 → 写 Claude Code 配置 → 后台常驻', value: 'setup' },
        { label: '启动反代', hint: '前台运行，Ctrl+C 退出', value: 'serve' },
        { label: '登录 / 换账号', hint: '', value: 'login' },
        { label: '查看状态', hint: '', value: 'status' },
        { label: '还原本工具写过的配置', hint: '', value: 'uninstall' },
        { label: '退出', hint: '', value: 'quit' },
      ],
    })
    if (action === 'quit') return 0
    if (action === 'setup') return await setupWizard()
    if (action === 'serve') return 'serve'
    if (action === 'login') await loginFlow([CN, INTL])
    if (action === 'status') await statusFlow()
    if (action === 'uninstall') await uninstallFlow()
  }
}
