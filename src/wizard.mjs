/**
 * 交互式界面：主菜单、一键配置、切换模型、状态、还原。
 *
 * 形态对齐 [zcf](https://github.com/UfoMiao/zcf)：开机 banner → 分区编号清单 →
 * 输入编号；每一步有标题，长操作有转圈，结束给一张摘要框。
 *
 * 两个取舍：
 * - **菜单只放常见的五件事**。其余能力（网关模式、指纹开关……）都在命令行参数里，
 *   不往菜单里堆 —— 选项越多越没人看。
 * - **每一步都如实报告**。写哪个文件、备份到哪、服务有没有真的起来，都在屏幕上
 *   说清楚；失败时给出可直接复制粘贴的补救命令。
 *
 * @module src/wizard.mjs
 */

import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import process from 'node:process'
import { CN, INTL } from './products.mjs'
import { OPENCODE } from './opencode.mjs'
import { SOURCES, needsLogin } from './sources.mjs'
import { login, credentialStatus } from './auth.mjs'
import { createDirectUpstream, createGatewayUpstream } from './upstreams.mjs'
import { credentialFile } from './config.mjs'
import {
  installClaudeSettings, installService, uninstallClaudeSettings, uninstallService,
  serviceState, claudeSettingsPath, readInstallState, serviceCliPath, currentCliPath,
} from './install.mjs'
import {
  banner, blank, box, confirm, gray, green, heading, info, input, menu, note,
  section, select, multiSelect, spinner, style, success, warn, fail, dim, yellow,
} from './prompt.mjs'

const DEFAULT_PORT = 8788
/** 面向 Claude Code 的推荐模型：这几个在本机实测跑通过。 */
const PREFERRED_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-free', 'hy4-preview-f', 'deepseek-v4-flash', 'glm-5.3']

function version() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

function shortNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

function modelHint(row, recommended = false) {
  const bits = []
  if (recommended) bits.push('推荐')
  if (row.free === true) bits.push('免费')
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

/**
 * 这个端口上是不是**本工具的桥**（而不是别的程序），是的话把它自报的配置带回来。
 *
 * 真实故障换来的：向导原来只问「端口空不空」，于是把**上一次装的服务**当成占用者，
 * 建议改用 8789 并写进 Claude Code 配置；用户那次又没装后台服务，8789 上空无一物
 * —— Claude Code 直接 `ECONNREFUSED`。
 */
export async function probeBridge(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) })
    if (!response.ok) return undefined
    const body = await response.json()
    return body?.service === 'claude-code-openai-bridge' ? body : undefined
  } catch {
    return undefined
  }
}

/** 端口决策：先复用已经在跑的本工具实例，再找第一个空闲端口。 */
async function choosePort() {
  const installed = readInstallState().service?.port
  if (await probeBridge(installed) !== undefined) return installed
  for (const port of [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2, 18788]) {
    if (await probeBridge(port) !== undefined) return port
    if (await portAvailable(port)) return port
  }
  return 0
}

/** 健康检查：确认服务真的把端口监听起来了，而不是只写了个文件。 */
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

async function loadModels(upstream) {
  const spin = spinner('读取模型清单…')
  try {
    return await upstream.loadModels()
  } finally {
    spin.stop()
  }
}

function currentSettings() {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function loggedInLabel(product) {
  if (!needsLogin(product)) return `${product.id} 无需登录`
  const status = credentialStatus(product)
  if (!status.loggedIn) return `${product.id} 未登录`
  return `${product.id} ${status.nickname === '' ? '已登录' : status.nickname}`
}

/** 菜单顶上那两行现状：不进子菜单也知道现在是什么状态。 */
async function statusLine() {
  const settings = currentSettings()
  const model = settings.env?.ANTHROPIC_MODEL ?? ''
  const port = Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:0').port)
  const running = await probeBridge(port)
  const service = serviceState()
  const state = running !== undefined ? green(`运行中（${port}）`) : service.installed ? '已安装但没在跑' : '未运行'
  note(`  ${gray('模型')} ${model === '' ? gray('未配置') : style.bold(model.replace('[1m]', ''))}   ${gray('服务')} ${state}`)
  note(`  ${gray('来源')} ${gray(SOURCES.map(source => loggedInLabel(source)).join(' · '))}`)
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/** 逐条来源登录；无需登录的跳过，已登录的也跳过，除非 `force`。 */
export async function ensureLoggedIn(products, { force = false } = {}) {
  for (const product of products) {
    // 无需登录的来源（OpenCode 免费档）也要明说一句，别让人以为它被漏掉了
    if (!needsLogin(product)) {
      success(`${product.label} 无需登录，直接可用`)
      continue
    }
    const status = credentialStatus(product)
    if (status.loggedIn && !force) {
      success(`${product.label} 已登录${status.nickname === '' ? '' : `（${status.nickname}）`}`)
      continue
    }
    heading(`登录 ${product.label}`)
    note(dim('  浏览器会打开授权页；终端里也会打印链接，SSH 环境下复制粘贴即可。'))
    try {
      await login(product, { log: line => note(`  ${line}`) })
    } catch (error) {
      fail(error?.message ?? String(error))
      if (!await confirm({ message: `跳过这条来源（${product.id}），继续？`, initial: true })) throw error
    }
  }
}

// ── 选模型 ──────────────────────────────────────────────────────────────────

/**
 * 从清单里挑模型。
 *
 * **全部列出、不截断**（三条来源合起来一百多个）：列表自己支持边打边筛，
 * 敲 `glm`、`oc/deep`、`1m` 都会立刻缩小范围 —— 早先只画前 10 个、再单开一个
 * 「输入关键词筛选…」入口，等于把 OpenCode 那八十多个模型藏起来了。
 * 另留一条手动输入：清单里没有的 ID（自建网关、新模型）也能用。
 */
export async function pickModel(rows) {
  const ranked = rankRows(rows)
  const free = ranked.filter(row => row.free === true)
  const paid = ranked.filter(row => row.free !== true)
  const toOption = (row, index) => ({ label: row.id, hint: modelHint(row, index === 0 && row.free !== true), value: row.id })
  const picked = await select({
    message: '用哪个模型？',
    filterable: true,
    options: [
      // 免费档排在最前并单独成组：一眼能看到哪些不花钱，也不用在 88 个 oc 模型里翻
      ...free.length > 0 ? [{ label: `免费模型（${free.length} 个）`, value: '__free__', separator: true }] : [],
      ...free.map(toOption),
      ...paid.length > 0 ? [{ label: `其余模型（${paid.length} 个，按量计费 / 订阅）`, value: '__paid__', separator: true }] : [],
      ...paid.map(toOption),
      { label: '手动输入模型 ID', hint: '清单里没有的模型', value: '__manual__' },
    ],
  })
  if (picked === '__manual__') {
    const id = await input({
      message: '模型 ID（形如 cn/xxx、intl/xxx、oc/xxx）',
      initial: ranked[0]?.id ?? '',
      validate: value => (value === '' ? '不能为空' : undefined),
    })
    return rows.find(row => row.id === id) ?? { id }
  }
  // 返回整行：窗口大小决定要不要给 Claude Code 登记 `[1m]`，不能只传 id
  return ranked.find(row => row.id === picked) ?? { id: picked }
}

/** 推荐模型排前面，其余保持远端顺序。 */
/** 免费优先，其次按推荐顺序；同组内保持远端给的原顺序。 */
function rankRows(rows) {
  return [...rows].sort((a, b) => {
    const free = (b.free === true ? 1 : 0) - (a.free === true ? 1 : 0)
    return free !== 0 ? free : rank(a.id) - rank(b.id)
  })
}

function rank(id) {
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const at = PREFERRED_MODELS.findIndex(preferred => bare === preferred)
  return at >= 0 ? at : PREFERRED_MODELS.length
}

// ── 一键配置 ────────────────────────────────────────────────────────────────

/** 网关模式的哨兵值：它不是一条「来源」，但和三家直连在同一个列表里互斥。 */
const GATEWAY = 'gateway'

export async function setupWizard() {
  heading('一键配置')
  note(dim('  四步：接哪几家 → 登录 → 选模型 → 写配置并常驻'))

  blank()
  section('第 1 步 · 接哪几家')
  // 一步问完：一行一条来源，国内版与国际版各占一行（原来捆成「WorkBuddy 两条线」，
  // 想只挑其中一条做不到），要哪些勾哪些。
  const chosen = await multiSelect({
    message: '接哪几家？',
    initial: [CN, INTL, OPENCODE],
    options: [
      { label: 'WorkBuddy 国内版（CodeBuddy）', hint: loggedInLabel(CN), value: CN },
      { label: 'WorkBuddy 国际版', hint: loggedInLabel(INTL), value: INTL },
      { label: 'OpenCode 免费档', hint: `${loggedInLabel(OPENCODE)}，免费模型`, value: OPENCODE },
      { label: '转发给已有的 OpenAI 兼容网关', hint: '自建网关 / LiteLLM / Ollama（勾它就只走它）', value: GATEWAY },
    ],
    // 网关与三家直连互斥：勾了一边就把另一边取消，省得用户勾出一个说不清的组合
    onToggle: (value, checked) => {
      if (value === GATEWAY) {
        for (const source of [CN, INTL, OPENCODE]) checked.delete(source)
      } else {
        checked.delete(GATEWAY)
      }
    },
  })

  blank()
  section('第 2 步 · 登录')
  let upstream
  const serviceEnv = {}
  if (chosen.includes(GATEWAY)) {
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
  } else {
    await ensureLoggedIn(chosen)
    upstream = createDirectUpstream({ products: chosen, credentialFile: credentialFile() }, { log: line => note(`  ${dim(line)}`) })
  }

  let rows = []
  try {
    rows = await loadModels(upstream)
  } catch (error) {
    fail(`拿不到模型清单：${error?.message ?? error}`)
  }
  if (rows.length === 0) {
    fail('没有可用模型。先检查登录或上游地址，再重新运行一键配置。')
    return 1
  }
  success(`${rows.length} 个模型可用`)

  blank()
  section('第 3 步 · 模型')
  const picked = await pickModel(rows)
  const model = picked.id
  serviceEnv.BRIDGE_MODEL = model

  blank()
  section('第 4 步 · 写入并常驻')
  // 端口不给选项：优先复用已在跑的本工具实例，否则取第一个空闲端口。
  const port = await choosePort()
  const apiKey = crypto.randomBytes(24).toString('base64url')
  const settingsFile = claudeSettingsPath()
  const applied = installClaudeSettings({
    file: settingsFile, baseUrl: `http://127.0.0.1:${port}`, apiKey, model,
    contextWindow: picked.contextWindow,
  })
  success(`已写入 ${settingsFile}`)
  if (applied.backup !== undefined) note(`  ${gray(`原文件已备份：${applied.backup}`)}`)

  const running = await probeBridge(port)
  const wantsService = await confirm({ message: '装成开机自启的后台服务？', initial: true })
  let service
  let health
  if (wantsService) {
    service = await installService({ port, apiKey, env: serviceEnv })
    if (service.ok) {
      success(`后台服务已装（${service.kind}）`)
      const spin = spinner('等待服务就绪…')
      health = await waitHealthy(`http://127.0.0.1:${port}`)
      spin.stop()
      if (health === undefined) {
        warn('12 秒内没等到 /health 应答。看日志：')
        note(`  ${gray(service.kind === 'launchd' ? '~/.claude-code-openai-bridge/bridge.err.log' : 'journalctl --user -u dev.claude-code-openai-bridge')}`)
      }
    } else {
      fail(service.reason)
      warn(`先手动跑起来：BRIDGE_PORT=${port} BRIDGE_API_KEY=${apiKey} node cli.mjs`)
    }
  } else if (running === undefined) {
    // 配置已经指向这个端口，这里却没人听 —— 必须当场说清楚，
    // 否则用户回到 Claude Code 只会看到 ECONNREFUSED。
    fail(`端口 ${port} 上没有服务在跑，Claude Code 会连不上`)
    warn(`先把桥跑起来：BRIDGE_PORT=${port} BRIDGE_API_KEY=${apiKey} node cli.mjs`)
  } else if (running.model !== model) {
    warn(`端口 ${port} 上已有服务在跑，但它钉的模型是 ${running.model}；要换成 ${model} 需要重装服务`)
  } else {
    success(`复用端口 ${port} 上已在运行的服务`)
  }

  blank()
  box([
    '配置完成',
    `${gray('模型')}  ${model}${picked.contextWindow === undefined ? '' : `  ${gray(`窗口 ${shortNumber(picked.contextWindow)}`)}`}`,
    `${gray('监听')}  http://127.0.0.1:${port}`,
    `${gray('服务')}  ${wantsService ? (health === undefined ? '已安装' : '运行中') : running === undefined ? '未常驻' : '复用已有实例'}`,
  ], { color: green })
  blank()
  info(`现在直接在任意目录运行 ${style.bold('claude')} 即可`)
  note(dim('  改模型：菜单里选「切换模型」   还原：菜单里选「还原配置」'))
  blank()
  return 0
}

// ── 切换模型 ────────────────────────────────────────────────────────────────

/**
 * 只换模型：配置文件与服务一起改。
 *
 * 服务是**不带参数启动**的，模型经环境变量传进去，所以必须重装一次才能生效。
 */
export async function switchModel() {
  heading('切换模型')
  const installed = readInstallState()
  const settings = currentSettings()
  const port = Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).port)
  const apiKey = settings.env?.ANTHROPIC_AUTH_TOKEN ?? crypto.randomBytes(24).toString('base64url')
  const env = installed.service?.env ?? {}
  const upstream = env.BRIDGE_MODE === 'gateway'
    ? createGatewayUpstream({ upstream: env.UPSTREAM_BASE_URL ?? 'http://127.0.0.1:8326', upstreamKey: env.UPSTREAM_API_KEY ?? '' })
    : createDirectUpstream({ products: SOURCES, credentialFile: credentialFile() }, { log: () => {} })

  let rows = []
  try {
    rows = await loadModels(upstream)
  } catch (error) {
    fail(`拿不到模型清单：${error?.message ?? error}`)
    return 1
  }
  if (rows.length === 0) {
    fail('没有可用模型；先跑一次一键配置把登录或上游修好。')
    return 1
  }
  const current = (settings.env?.ANTHROPIC_MODEL ?? '').replace(/\[[^\]]*\]$/, '')
  const ranked = [...rows].sort((a, b) => rank(a.id) - rank(b.id))
  // 只展示前 12 个，所以「当前模型」的下标要在**截断之后**的列表里算。
  const shown = ranked.slice(0, 12)
  const chosen = await select({
    message: '换成哪个模型？',
    initial: Math.max(0, shown.findIndex(row => row.id === current)),
    options: shown.map((row, index) => ({ label: row.id, hint: modelHint(row, index === 0), value: row.id })),
  })
  const model = chosen
  const contextWindow = shown.find(row => row.id === chosen)?.contextWindow

  installClaudeSettings({ file: claudeSettingsPath(), baseUrl: `http://127.0.0.1:${port}`, apiKey, model, contextWindow })
  success(`配置已更新：${model}${contextWindow !== undefined && contextWindow > 200_000 ? '[1m]' : ''}`)

  if (installed.service?.path !== undefined && fs.existsSync(installed.service.path)) {
    const service = await installService({ port, apiKey, env: { ...env, BRIDGE_MODEL: model } })
    if (service.ok) {
      const spin = spinner('重启服务…')
      const health = await waitHealthy(`http://127.0.0.1:${port}`)
      spin.stop()
      if (health === undefined) warn('服务重启后 12 秒内没有应答，看看日志')
      else success(`服务已在 ${port} 上按新模型运行`)
    } else fail(service.reason)
  } else {
    warn('没有装后台服务：下次启动会用新模型；已经在跑的实例要手动重启')
  }
  blank()
  return 0
}

// ── 其它 ────────────────────────────────────────────────────────────────────

export async function statusFlow() {
  heading('状态')
  for (const product of SOURCES) {
    if (!needsLogin(product)) {
      note(`  ${product.id.padEnd(5)} ${product.label}  ${gray('无需登录（免费档）')}`)
      continue
    }
    const status = credentialStatus(product)
    if (!status.loggedIn) {
      note(`  ${product.id.padEnd(5)} ${product.label}  ${gray('未登录')}`)
      continue
    }
    const when = status.expiresAt === undefined ? '' : new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })
    note(`  ${product.id.padEnd(5)} ${product.label}  ${status.nickname === '' ? '已登录' : status.nickname}`)
    note(`        ${gray(`${when}${status.refreshable ? ' · 可静默续期' : ''}`)}`)
  }
  const service = serviceState()
  const settings = currentSettings()
  const port = Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:0').port)
  const running = await probeBridge(port)
  blank()
  note(`  服务      ${service.installed ? `已安装（${service.kind}）` : '未安装'} ${running === undefined ? gray('未在运行') : green(`运行中 ${port}`)}`)
  note(`  服务文件  ${gray(service.path === '' ? '-' : service.path)}`)
  const runningCode = service.installed ? serviceCliPath() : undefined
  if (runningCode !== undefined && runningCode !== currentCliPath()) {
    // 这一条是真实踩过的坑：服务指向全局安装的快照，于是「命令行有、服务里没有」
    note(`  服务代码  ${yellow(runningCode)}`)
    warn('服务跑的不是当前这份代码（全局安装是一份快照）；`ccb setup` 重装一次即可对齐')
  } else if (runningCode !== undefined) {
    note(`  服务代码  ${gray(runningCode)}`)
  }
  note(`  配置文件  ${gray(readInstallState().claudeSettings?.file ?? '本工具未写入过')}`)
  note(`  凭据文件  ${gray(credentialFile())}`)
  blank()
  return 0
}

export async function uninstallFlow() {
  heading('还原配置')
  const settings = uninstallClaudeSettings()
  if (settings.skipped === true) note(`  Claude Code 配置：${settings.reason}`)
  else success(`已从 ${settings.file} 移除 ${settings.removed.length} 个键`)
  if (settings.backup !== undefined) note(`  ${gray(`还原前的备份：${settings.backup}`)}`)
  const service = uninstallService()
  if (service.skipped === true) note(`  后台服务：${service.reason}`)
  else success(`已卸载后台服务（${service.kind}）`)
  blank()
  return 0
}

/** 重新登录 / 换账号。 */
export async function loginFlow() {
  heading('重新登录')
  const which = await select({
    message: '登录哪一条？',
    options: [
      { label: '两条都重新登录', hint: `${loggedInLabel(CN)} / ${loggedInLabel(INTL)}`, value: [CN, INTL] },
      { label: '国内版（CodeBuddy）', hint: loggedInLabel(CN), value: [CN] },
      { label: '国际版（WorkBuddy）', hint: loggedInLabel(INTL), value: [INTL] },
    ],
  })
  await ensureLoggedIn(which, { force: true })
  blank()
  return 0
}

// ── 主菜单 ──────────────────────────────────────────────────────────────────

/** 不给参数又是在终端里跑时进这里。返回 'serve' 表示要继续起服务。 */
export async function mainMenu() {
  for (;;) {
    banner('Claude Code ← WorkBuddy / OpenCode 本地反代', version())
    await statusLine()
    const choice = await menu({
      title: '请选择要做什么：',
      groups: [
        {
          items: [
            { key: '1', label: '一键配置', hint: '接哪几家 → 选模型 → 写 Claude Code 配置 → 后台常驻' },
            { key: '2', label: '切换模型', hint: '改完自动重启服务' },
            { key: '3', label: '查看状态', hint: '登录有效期 / 服务 / 文件位置' },
          ],
        },
        {
          title: '维护',
          items: [
            { key: '4', label: '重新登录（换账号）', hint: '浏览器授权' },
            { key: '0', label: '还原配置', hint: '移除本工具写入的键并卸载后台服务' },
            { key: 'Q', label: '退出', hint: '', danger: true },
          ],
        },
      ],
    })
    if (choice === 'Q') return 0
    if (choice === '1') return await setupWizard()
    if (choice === '2') await switchModel()
    if (choice === '3') await statusFlow()
    if (choice === '4') await loginFlow()
    if (choice === '0') await uninstallFlow()
    await input({ message: '按回车返回菜单' })
  }
}
