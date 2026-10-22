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
import { OPENCODE, OPENCODE_GO, goCredential, goKeyTail, hasGoCredential, saveGoKey } from './opencode.mjs'
import { SOURCES, needsLogin, sourceByName } from './sources.mjs'
import { credentialChecks, localIssues, localSnapshot, probeOpencodeGate, probeOpencodeGo, probeTencentFingerprint } from './doctor.mjs'
import { HEALTH_SERVICE_NAMES } from './install.mjs'
import { login, credentialStatus } from './auth.mjs'
import { createDirectUpstream, createGatewayUpstream } from './upstreams.mjs'
import { credentialFile, DEFAULT_LOCAL_API_KEY } from './config.mjs'
import { installClaudeSettings, installService, uninstallClaudeSettings, uninstallService, serviceState, serviceChoice, recordServiceChoice, claudeSettingsPath, readInstallState, serviceCliPath, currentCliPath, LEGACY_SERVICE_LABEL, CLIENT_TARGETS, clientChoice, recordClientChoice, bridgeRecord, recordBridge, sizedModelId, clientConfigIsOurs } from './install.mjs'
import { HOME_DIR, LEGACY_HOME_DIR, legacyHomeInUse } from './home.mjs'
import { DEFAULT_DSH_REASONING, DSH_SOURCE_IDS, applyDshConfig, dshCurrentlyManaged, removeDshConfig } from './dsh.mjs'
import {
  banner, blank, box, confirm, gray, green, heading, info, input, isInteractive, menu, note,
  section, select, password, spinner, style, success, warn, fail, dim, yellow,
} from './prompt.mjs'
import { SUBTYPES, validationError } from './errors.mjs'

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
    // 认新旧两个名字：改名过渡期里，端口上跑的可能是老名字的那份（见 install.mjs）
    return HEALTH_SERVICE_NAMES.has(body?.service) ? body : undefined
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
  if (product.auth === 'key') return hasGoCredential() ? `${product.id} 已配 key` : `${product.id} 未配 key`
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
    // 填 key 这条路：没有浏览器授权可走，直接问 key
    if (product.auth === 'key') {
      if (hasGoCredential() && !force) {
        success(`${product.label} 已配 key（末四位 ${goKeyTail()}）`)
        continue
      }
      heading(`配置 ${product.label}`)
      note(dim('  在 opencode.ai 控制台生成 API key（Go 套餐订阅里的那个），粘贴到这里。'))
      const value = await password({
        message: 'OpenCode API key',
        validate: input => (input.trim().length < 20 ? '看起来不像一个 key' : undefined),
      })
      const saved = saveGoKey(value)
      success(`已保存（末四位 ${saved.apiKey.slice(-4)}），会话 id ${saved.session.slice(0, 8)}…`)
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

/** 网关模式的哨兵值：它不是一条「来源」，但和三家直连并列在同一个问题里。 */
const GATEWAY = 'gateway'

/**
 * 这一次选的来源 + 已经在挂的来源 = 新的挂载清单。
 *
 * 一次只配一家，所以重复运行是**叠加**而不是覆盖：先配了国内版，再从菜单进来配
 * OpenCode，结果是两家都挂着，而不是把国内版顶掉。
 */
function mountedSources(chosen) {
  const recorded = readInstallState()?.service?.env?.BRIDGE_PRODUCTS
  const current = typeof recorded === 'string' && recorded.trim() !== ''
    ? recorded.split(',').map(name => sourceByName(name)).filter(source => source !== undefined)
    : [...SOURCES]
  if (chosen === undefined) return current.length > 0 ? current : [...SOURCES]
  return current.includes(chosen) ? current : [...current, chosen]
}

/**
 * DSH 的 provider 要覆盖**所有挂着的来源**，而不是这次才选中的那一家。
 *
 * 踩过：`setup` 里 `loadModels` 只加载 `[chosen]` 一家的模型，于是 DSH 的托管段每次都被
 * 重写成「只有刚选的那个版本」—— 先配 intl 再配 cn，intl 的 provider 就没了
 * （2026-10-22 用户反馈「国际版和国内版没有同时存在」）。这里按挂载清单重新取一次。
 *
 * 取不到就退回本次的清单：DSH 少一个 provider 也不该把整个 setup 搞挂。
 */
export function dshProducts(chosen, mounted = mountedSources(chosen)) {
  // 只给腾讯两条线：`GATEWAY` 是伪来源、oc/ocg 在 DSH 里本来就有自己的 provider
  return mounted.filter(source => SOURCES.includes(source) && DSH_SOURCE_IDS.includes(source.id))
}

async function dshModelRows(chosen, fallback) {
  const sources = dshProducts(chosen)
  if (sources.length === 0) return fallback
  try {
    return await loadModels(createDirectUpstream({ products: sources, credentialFile: credentialFile() }, { log: () => {} }))
  } catch {
    return fallback
  }
}

/**
 * 决定这次要不要装后台服务，并**只在需要时问一次**。
 *
 * 用户明确抱怨过：装过一次之后，每次配置都还要再问一遍要不要开机自启。规则：
 *   1. 显式 `--service` / `--no-service` 最优先（脚本化场景要能表态）；
 *   2. 已经装过 → 不问，直接更新；
 *   3. 问过且当时选了不装 → 不问，只提示怎么开启；
 *   4. 从没表态 → 问一次（默认「要」），把答案记进 `install.json`。
 *
 * `state` / `choice` / `ask` 都可以注入，用例因此能在不碰 launchd / systemd 的前提下
 * 断言「问了没问」。
 */
export async function decideService({ service, state = serviceState(), choice = serviceChoice(), ask = confirm } = {}) {
  if (!state.supported) {
    warn('这个平台没有实现后台常驻，跳过（服务相关命令在 macOS 与 Linux 上可用）')
    return false
  }
  // flag 是「这一次」的表态，不落账本：脚本每次都带着它，而把一次性的选择记成
  // 永久偏好，会让下一次交互式配置再也见不到这一问。
  if (service !== undefined) return service
  if (state.installed) {
    note(dim(`  后台服务已装（${state.kind}），本次直接更新`))
    return true
  }
  if (choice.asked && !choice.autoStart) {
    note(dim('  按你上次的选择跳过后台服务；要开启：fo setup --service'))
    return false
  }
  const wants = await ask({ message: '装成开机自启的后台服务？', initial: true })
  recordServiceChoice(wants)
  return wants
}

const CLIENT_LABELS = { claude: 'Claude Code', dsh: 'DSH' }

/** 两个独立的是非问句（不问「要配哪些」——那是把两个开关塞进一个单选）。 */
const CLIENT_QUESTIONS = {
  claude: '帮你也写 Claude Code 的配置（~/.claude/settings.json）？',
  dsh: '帮你也写 DSH 的配置（llm-pi-ai provider）？',
}

function labelOfClients(ids) {
  return ids.map(id => CLIENT_LABELS[id] ?? id).join(' / ')
}

/**
 * 「要不要帮你写客户端配置」这一问 —— Claude Code、DSH 各问一次（两个独立开关）。
 *
 * 本工具的本分是**提供反代**；改客户端的配置只是顺手帮忙 —— Windows 上动别人家配置还
 * 可能撞权限（2026-10-19 真机 EPERM）。
 *
 * ⚠️ 这一问**每次都问**（与「要不要开机自启」不同）：它问的是「这次要动谁的文件」，
 * 用户随时可能只想配反代、或只改 DSH。问过一次就再也不问，等于把口径锁死了、想改都没
 * 机会改（2026-10-22 用户反馈）。账本里记的答案只当**默认值**用：一路回车就是上次的
 * 选择。显式 `--clients` 才跳过提问。
 *
 * 「已经归我们管的配置」必须继续更新（换密钥、不写就是 401），所以 `ours` 会被无条件
 * 并进来 —— 一致性不是可选项。
 */
export async function decideClientTargets({ clients, ours = [], choice = clientChoice(), ask = confirm } = {}) {
  if (Array.isArray(clients)) return clients.filter(id => CLIENT_TARGETS.includes(id))
  const keep = [...new Set(ours.filter(id => CLIENT_TARGETS.includes(id)))]
  if (keep.length > 0) {
    note(dim(`  ${labelOfClients(keep)} 的配置本来就指向本桥：会继续更新`))
  }
  const remembered = new Set(choice.asked ? choice.clients : [])
  const picked = []
  // 两个独立开关，一个问题一个 —— 不做「两个都写」那种组合选项：组合是 UI 的事，
  // 答案本来就是两个布尔值（zcf 也是这么问的：要配什么就问什么，不搞多选）。
  for (const id of CLIENT_TARGETS) {
    const forced = keep.includes(id)
    const wants = await ask({
      message: CLIENT_QUESTIONS[id],
      initial: forced || remembered.has(id),
    })
    if (wants || forced) picked.push(id)
  }
  recordClientChoice(picked)
  return picked
}

/**
 * 第 4 步里「写不写客户端配置」这一半。
 *
 * 单独成函数是为了能离线断言：用户说「不写」时，**一个字节都不能碰**他的文件。
 */
export function applyClientConfig({ wantsClient, file, baseUrl, apiKey, model, contextWindow }) {
  if (wantsClient !== true) return { written: false }
  return { written: true, ...installClaudeSettings({ file, baseUrl, apiKey, model, contextWindow }) }
}

/**
 * 桥的门禁口令：**复用已有的，第一次装就落固定默认值**。
 *
 * 之前每次 setup 都 `crypto.randomBytes` 一把新的，结果：Claude Code 的配置要跟着重写，
 * DSH 凭据 seam 里引用的那把 key 直接过期（真机表现：DSH 报「密钥无效」，而桥其实活着）。
 * 客户端配置会长期引用它，所以它必须是**稳定的**。
 */
export function bridgeApiKey({ record = bridgeRecord(), settings = currentSettings(), fallback = DEFAULT_LOCAL_API_KEY } = {}) {
  const existing = record?.apiKey ?? settings?.env?.ANTHROPIC_AUTH_TOKEN
  return typeof existing === 'string' && existing.trim() !== '' ? existing : fallback
}

/**
 * 「自己配」要的那三项：地址 / 令牌 / 模型 ID。
 *
 * 只返回文本、**不写任何文件** —— 这就是「不帮你改配置」那条路的意义。
 */
export function connectionInfo({ port, apiKey, model, contextWindow }) {
  const baseUrl = `http://127.0.0.1:${port}`
  const sized = sizedModelId(model, contextWindow)
  return [
    `接入地址  ${baseUrl}`,
    `令牌      ${apiKey}`,
    `模型 ID   ${sized}`,
    'Claude Code：把上面三项填进 settings.json 的 env —— ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL',
    'DSH：llm-pi-ai 的 provider 填 api: anthropic-messages、baseURL 同上、models 里填模型 ID；令牌存进凭据 seam 后用 apiKeyEnv 引用',
  ].join('\n')
}

/** 把接入信息按「每行缩进两格」打出来（空行不缩进）。 */
function printConnectionInfo(info) {
  for (const line of info.split('\n')) note(line === '' ? '' : `  ${line}`)
}

/**
 * `fo client`：随时打印接入信息。
 *
 * 选了「不写客户端配置」的人（尤其 Windows 上不想被动 `~/.claude`）靠它拿端口/令牌/
 * 模型 ID；配置过的人也可以用它在别的客户端里抄一份。
 */
export async function clientFlow() {
  heading('接入信息')
  const record = bridgeRecord()
  const settings = currentSettings()
  const port = record.port ?? Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).port)
  const apiKey = record.apiKey ?? settings.env?.ANTHROPIC_AUTH_TOKEN
  const model = record.model ?? String(settings.env?.ANTHROPIC_MODEL ?? '').replace(/\[[^\]]*\]$/, '')
  if (typeof apiKey !== 'string' || apiKey === '' || model === '') {
    fail('还没有配置过：先跑 fo setup（只想配反代就加 --clients none）')
    blank()
    return 1
  }
  printConnectionInfo(connectionInfo({ port, apiKey, model, contextWindow: record.contextWindow }))
  blank()
  // 顺手说清「哪些客户端是我们帮你配的」，免得用户以为没配
  const managed = []
  if (clientConfigIsOurs({ port })) managed.push('Claude Code（settings.json）')
  if (dshCurrentlyManaged()) managed.push('DSH（llm-pi-ai provider）')
  note(dim(managed.length === 0
    ? '  两个客户端都没配（按你的选择）；上面的信息可以直接填'
    : `  已帮你配：${managed.join('、')}`))
  blank()
  info(`前台把桥跑起来：${serveCommand(port, apiKey)}`)
  blank()
  return 0
}

/**
 * 「自己把桥跑起来」要照抄的那条命令。
 *
 * 不写成 `BRIDGE_PORT=8788 BRIDGE_API_KEY=… node cli.mjs`：那是 POSIX 的赋值前缀，
 * Windows 的 cmd 与 PowerShell 都不认（照抄只会得到「不是内部或外部命令」），而这条提示
 * 恰恰在 Windows 上最常出现 —— 那边没有后台常驻，向导每次都会走到这一步。
 * flag 形式三种壳都认，端口与密钥也跟 `settings.json` 里钉住的一致。
 */
export function serveCommand(port, apiKey) {
  return `node cli.mjs serve --port ${port} --api-key ${apiKey}`
}

/**
 * 一键配置。
 *
 * `options.service` 是调用方给的显式表态（`--service` / `--no-service`）；
 * `options.client` 是「要不要帮你写 Claude Code 配置」（`--client` / `--no-client`）。
 * 不给（`undefined`）时都按账本与现状自动决定，见 `decideService` / `decideClientConfig`。
 */
export async function setupWizard(options = {}) {
  // 一键配置全程是菜单交互：没有 TTY 时（systemd、launchd、管道、被 agent 调用）
  // 以前会照常打印菜单、拿到 undefined、然后**退出码 0** —— 调用方以为配好了，
  // 实际一个字节都没写（2026-10-22 真机：`fo setup --clients dsh …` 静默成功）。
  // 这类失败必须当场说清楚，而不是留一个假的成功。
  if (!isInteractive()) {
    throw validationError(
      SUBTYPES.INVALID_REQUEST,
      '一键配置需要交互式终端（当前 stdin/stdout 不是 TTY）',
    ).withHint('非交互场景改用：`flow-one` 前台起反代，然后手动写客户端配置；'
      + '接入信息用 `flow-one client` 打印（地址 / 令牌 / 模型 ID）')
  }
  heading('一键配置')
  note(dim('  一次配一家：接哪一家 → 登录 → 选模型 → 配反代（客户端配置可选）→ 常驻'))
  note(dim('  想再挂一家，配完回菜单再选一次「一键配置」即可（不会顶掉先前的）'))

  blank()
  section('第 1 步 · 接哪一家')
  const chosen = await select({
    message: '接哪一家？',
    options: [
      { label: 'WorkBuddy 国内版（CodeBuddy）', hint: loggedInLabel(CN), value: CN },
      { label: 'WorkBuddy 国际版', hint: loggedInLabel(INTL), value: INTL },
      { label: 'OpenCode 免费档', hint: `${loggedInLabel(OPENCODE)}，免费模型`, value: OPENCODE },
      { label: 'OpenCode Go 套餐', hint: `${loggedInLabel(OPENCODE_GO)}，付费订阅（DeepSeek V4.1 Pro、GLM、Kimi、Grok…）`, value: OPENCODE_GO },
      { label: '转发给已有的 OpenAI 兼容网关', hint: '自建网关 / LiteLLM / Ollama', value: GATEWAY },
    ],
  })

  blank()
  section('第 2 步 · 登录')
  let upstream
  const serviceEnv = {}
  if (chosen === GATEWAY) {
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
    await ensureLoggedIn([chosen])
    upstream = createDirectUpstream({ products: [chosen], credentialFile: credentialFile() }, { log: line => note(`  ${dim(line)}`) })
    serviceEnv.BRIDGE_MODE = 'direct'
    serviceEnv.BRIDGE_PRODUCTS = mountedSources(chosen).map(source => source.id).join(',')
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
  // 口令必须稳定：客户端配置会长期引用它（随机换会让 Claude Code 401、DSH 报「密钥无效」）
  const apiKey = bridgeApiKey()
  const ours = []
  if (clientConfigIsOurs({ port })) ours.push('claude')
  if (dshCurrentlyManaged()) ours.push('dsh')
  const targets = await decideClientTargets({ clients: options.clients, ours })
  // 接入参数与「写不写客户端配置」无关：账本里总要有一份，`fo client` 与前台跑桥都靠它
  recordBridge({ port, apiKey, model, contextWindow: picked.contextWindow })

  const applied = applyClientConfig({
    wantsClient: targets.includes('claude'),
    file: claudeSettingsPath(),
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    model,
    contextWindow: picked.contextWindow,
  })
  if (applied.written) {
    success(`Claude Code 配置已写入 ${applied.file}`)
    if (applied.backup !== undefined) note(`  ${gray(`原文件已备份：${applied.backup}`)}`)
  }

  // DSH：写 llm-pi-ai provider + 凭据 seam（只写腾讯两条线，oc/ocg 在 DSH 里本来就有）
  let dsh = { ok: true, skipped: true }
  if (targets.includes('dsh')) {
    dsh = applyDshConfig({
      port,
      apiKey,
      rows: await dshModelRows(chosen, rows),
      // 默认档位固定 high（与 DSH 自己的 provider 一致）；--dsh-reasoning none 才留 Default
      reasoning: options.dshReasoning ?? DEFAULT_DSH_REASONING,
    })
    if (dsh.ok) {
      success(`DSH provider 已写入 ${dsh.file}（${dsh.models} 个模型）`)
      note(dim('  重启 DSH 后，模型选择器里会出现 WorkBuddy 国内版 / 国际版'))
      if (dsh.backup !== undefined) note(`  ${gray(`原文件已备份：${dsh.backup}`)}`)
    } else {
      warn(`DSH 没配上：${dsh.reason}`)
    }
  }
  if (targets.length === 0) {
    note(dim('  只配反代，没动任何客户端配置；接入信息在最后，随时可用 fo client 再看'))
  }

  const running = await probeBridge(port)
  const wantsService = await decideService({ service: options.service })
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
        note(`  ${gray(service.kind === 'launchd' ? '~/.flow-one/bridge.err.log' : 'journalctl --user -u dev.flow-one')}`)
      }
    } else {
      fail(service.reason)
      warn(`先手动跑起来：${serveCommand(port, apiKey)}`)
    }
  } else if (running === undefined) {
    // 配置已经指向这个端口，这里却没人听 —— 必须当场说清楚，
    // 否则用户回到 Claude Code 只会看到 ECONNREFUSED。
    fail(`端口 ${port} 上没有服务在跑，Claude Code 会连不上`)
    warn(`先把桥跑起来：${serveCommand(port, apiKey)}`)
  } else if (running.model !== model) {
    warn(`端口 ${port} 上已有服务在跑，但它钉的模型是 ${running.model}；要换成 ${model} 需要重装服务`)
  } else {
    success(`复用端口 ${port} 上已在运行的服务`)
  }

  blank()
  const mounted = chosen === GATEWAY
    ? ['上游网关']
    : mountedSources(chosen).map(source => `${source.id}（${source.label}）`)
  box([
    '配置完成',
    `${gray('本次')}  ${chosen === GATEWAY ? '转发给已有网关' : `${chosen.id}（${chosen.label}）`}`,
    `${gray('模型')}  ${model}${picked.contextWindow === undefined ? '' : `  ${gray(`窗口 ${shortNumber(picked.contextWindow)}`)}`}`,
    `${gray('已挂')}  ${mounted.join('、')}`,
    `${gray('监听')}  http://127.0.0.1:${port}`,
    `${gray('服务')}  ${wantsService ? (health === undefined ? '已安装' : '运行中') : running === undefined ? '未常驻' : '复用已有实例'}`,
    `${gray('客户端')}  ${targets.length === 0 ? '都没动（自己填接入信息）' : [applied.written ? 'Claude Code' : '', dsh.ok === true && targets.includes('dsh') ? 'DSH' : ''].filter(Boolean).join(' + ')}`,
  ], { color: green })
  if (targets.length === 0) {
    blank()
    note(style.bold('  把下面三项填到你自己的客户端里（本工具没有改任何配置文件）'))
    printConnectionInfo(connectionInfo({ port, apiKey, model, contextWindow: picked.contextWindow }))
    note(dim('  随时再看一眼：fo client'))
  }
  blank()
  info(`现在直接在任意目录运行 ${style.bold('claude')} 即可`)
  note(dim('  再挂一家：菜单里再选一次「一键配置」   改模型：「切换模型」   还原：「还原配置」'))
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
  // 接入参数优先读账本的 bridge 段：选了「不写客户端配置」的人，settings.json 里没有我们的键
  const record = bridgeRecord()
  const port = record.port ?? Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).port)
  const apiKey = bridgeApiKey({ record, settings })
  const env = installed.service?.env ?? {}
  const upstream = env.BRIDGE_MODE === 'gateway'
    ? createGatewayUpstream({ upstream: env.UPSTREAM_BASE_URL ?? 'http://127.0.0.1:8326', upstreamKey: env.UPSTREAM_API_KEY ?? '' })
    // 只列真正挂着的来源，别给出一个切过去必然找不到的模型
    : createDirectUpstream({ products: mountedSources(), credentialFile: credentialFile() }, { log: () => {} })

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
  const current = String(record.model ?? settings.env?.ANTHROPIC_MODEL ?? '').replace(/\[[^\]]*\]$/, '')
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

  recordBridge({ port, apiKey, model, contextWindow })
  // 配置指向本桥就必须回写：换了密钥/模型却不写，客户端会拿着旧令牌 401。
  // 只对「不属于本桥」的配置保持不动（那是用户自己的东西）。
  if (clientConfigIsOurs({ port })) {
    installClaudeSettings({ file: claudeSettingsPath(), baseUrl: `http://127.0.0.1:${port}`, apiKey, model, contextWindow })
    success(`配置已更新：${sizedModelId(model, contextWindow)}`)
  } else {
    note(dim(`  没动 Claude Code 的配置（按你上次的选择）；新模型 ID：${sizedModelId(model, contextWindow)}（fo client 可再看）`))
  }

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
    // Go 套餐的凭据是 key（存在 `opencode-go` 条目下），不是登录态；
    // credentialStatus 按 `ocg` 去读必然读空，配好了也会显示「未登录」。
    if (product.auth === 'key') {
      note(`  ${product.id.padEnd(5)} ${product.label}  ${gray(hasGoCredential() ? '已配 key' : '未配 key（在 `fo setup` 里填）')}`)
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
  if (!service.installed && service.legacyInstalled) {
    // 这个状态最容易被误读：界面上是「未安装」，可旧服务其实正在跑、占着端口
    note(`  服务      ${yellow('未安装（但改名前的旧服务还在跑）')} ${running === undefined ? gray('未在运行') : green(`运行中 ${port}`)}`)
    note(gray('            → 跑一次「一键配置」会装成新名字并顺手清掉旧服务；只想清旧的：fo uninstall'))
  } else {
    note(`  服务      ${service.installed ? `已安装（${service.kind}）` : '未安装'} ${running === undefined ? gray('未在运行') : green(`运行中 ${port}`)}`)
  }
  if (legacyHomeInUse()) {
    note(`  数据目录  ${gray(`还是改名前的 ~/${LEGACY_HOME_DIR}（照常用，登录态在里面）`)}`)
    note(gray(`            → 想搬到新名字：mv ~/${LEGACY_HOME_DIR} ~/${HOME_DIR}`))
  }
  note(`  服务文件  ${gray(service.path === '' ? '-' : service.path)}`)
  const runningCode = service.installed ? serviceCliPath() : undefined
  if (runningCode !== undefined && runningCode !== currentCliPath()) {
    // 这一条是真实踩过的坑：服务指向全局安装的快照，于是「命令行有、服务里没有」
    note(`  服务代码  ${yellow(runningCode)}`)
    warn('服务跑的不是当前这份代码（全局安装是一份快照）；`fo setup` 重装一次即可对齐')
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
  const dsh = removeDshConfig()
  if (dsh.removed) success('已清掉 DSH 里的 flow-one provider 与凭据引用')
  else note('  DSH：没有本工具写入的记录')
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
      { label: 'OpenCode Go 套餐（换 key）', hint: loggedInLabel(OPENCODE_GO), value: [OPENCODE_GO] },
    ],
  })
  await ensureLoggedIn(which, { force: true })
  blank()
  return 0
}

/**
 * 自检。
 *
 * 功能内核压在两条别人家的规则上（腾讯的内容风控字面量、OpenCode 的免费档形状门禁），
 * 它们都可能变。这里不只查「活没活着」，而是**主动重推一遍门禁**并把每一项的判定
 * 打出来 —— 上游一收紧，用户自己就能看到是哪一条失效。
 */
export async function doctorFlow() {
  heading('自检')

  section('配置与服务')
  const snapshot = localSnapshot()
  note(`  ${gray(snapshot.settingsFile)}`)
  const url = snapshot.settings?.env?.ANTHROPIC_BASE_URL
  const port = typeof url === 'string' ? Number(/:([0-9]+)\s*$/.exec(url)?.[1]) : undefined
  // 「端口上有没有人在听」只能由**探测**回答，不能由「服务文件装没装」推断：
  // 端口上跑的可能是改名前的旧服务（label 不同 → installed 为 false），也可能是前台起的。
  // 真机上撞到过：服务明明在跑、claude 也通，doctor 却报「没有服务在跑」——
  // 因为旧 label 的服务不算 installed，于是连探测都没做就直接判 false。
  const healthOk = Number.isFinite(port) ? (await probeBridge(port)) !== undefined : false
  const { issues, ok } = localIssues({ ...snapshot, healthOk })
  for (const text of ok) success(text)
  for (const issue of issues) {
    if (issue.level === 'fail') fail(issue.text)
    else warn(issue.text)
    if (issue.fix !== undefined) note(`  ${dim(`→ ${issue.fix}`)}`)
  }
  if (ok.length === 0 && issues.length === 0) warn('没读到任何配置，可能还没配过')

  blank()
  section('登录')
  for (const row of credentialChecks()) {
    if (row.ok) success(`${row.label} ${row.text}`)
    else fail(`${row.label} ${row.text}`)
    if (row.fix !== undefined) note(`  ${dim(`→ ${row.fix}`)}`)
  }

  blank()
  section('腾讯内容风控（真发一次最小请求）')
  note(dim('  被拦的表现是 400 + code 11128；额度受限不算门禁问题'))
  let blocked = false
  for (const source of SOURCES) {
    // 只测腾讯那两条线：这一节验的是内容风控的字面量规则，与 OpenCode 两条路无关
    if (source.auth !== 'oauth') continue
    const status = credentialStatus(source)
    if (!status.loggedIn) {
      note(`  ${gray(`${source.label} 未登录，跳过`)}`)
      continue
    }
    const spin = spinner(`探测 ${source.label}…`)
    const result = await probeTencentFingerprint(source, { log: () => {} })
    spin.stop()
    if (result.ok) success(`${source.label} 通过（改写器生效）`)
    else if (result.limited) warn(`${source.label} 额度/频率受限，本次无法验证（不是门禁问题）`)
    else if (result.blocked) {
      blocked = true
      fail(`${source.label} 被内容风控拦下：${result.message}`)
    } else fail(`${source.label} 探测失败：${result.message}`)
  }

  blank()
  const go = await probeOpencodeGo()
  section('OpenCode Go 套餐（认证通道）')
  if (go.configured !== true) {
    note(`  ${gray('未配置 API key，跳过（菜单「一键配置」里选 OpenCode Go 套餐）')}`)
  } else {
    note(dim(`  key 末四位 ${go.tail}；这条路没有形状门禁，但要求会话头`))
    for (const row of go.rows) {
      if (row.verdict === 'pass') success(`${row.label} → ${row.status}${row.count === undefined ? '' : `（${row.count} 个模型）`}`)
      else if (row.verdict === 'relaxed') note(`  ${yellow('○')} ${row.label} → ${row.status} ${gray('（这条已不再是必填项）')}`)
      else if (row.verdict === 'inconclusive') warn(`${row.label} → ${row.status || '连不上'} ${row.message ?? ''}`)
      else fail(`${row.label} → ${row.status} ${row.message ?? ''}`)
    }
  }

  blank()
  section('OpenCode 免费档门禁（重推一遍）')
  note(dim('  完整形状应 200；逐项去掉一个要件，应被 403 拒掉'))
  const gateSpin = spinner('探测中…')
  const gate = await probeOpencodeGate()
  gateSpin.stop()
  for (const row of gate.rows) {
    if (row.verdict === 'pass') success(`${row.label} → ${row.status}${row.errorType === undefined ? '' : ` ${row.errorType}`}`)
    else if (row.verdict === 'relaxed') note(`  ${yellow('○')} ${row.label} → ${row.status} ${gray('（这一条已不再是必填项，上游放松了）')}`)
    // 「判不出来」有三条来路，都得走 warn 而不是红：这一行自己判不出来、这一轮整体
    // 判不出来（限流/连不上）、以及整轮收紧时其余行也一并降级。
    else if (row.verdict === 'inconclusive' || (row.verdict === 'fail' && gate.inconclusive === true)) {
      warn(`${row.label} → ${row.status || '连不上'} ${row.message ?? ''}`)
    } else fail(`${row.label} → ${row.status} ${row.errorType ?? ''} ${row.message ?? ''}`)
  }
  if (gate.tightened === true) {
    fail('完整形状已被拒 —— 上游收紧了免费档门禁')
    note(`  ${dim('规则与实测记录见 docs/gates.md，改完用 `fo doctor` 复验')}`)
  } else if (gate.inconclusive === true) {
    warn('没能判定门禁状态（网络或限流），稍后再试')
  } else {
    success('免费档门禁仍然成立')
  }

  blank()
  const verdict = issues.some(issue => issue.level === 'fail') || blocked || gate.tightened === true
  box([
    verdict ? '自检发现问题（见上）' : '自检通过',
    `${gray('门禁')}  ${gate.tightened === true ? '免费档形状已失效' : gate.inconclusive === true ? '无法判定' : '仍然成立'}${blocked ? ' / 腾讯风控拦下了请求' : ''}`,
    `${gray('配置')}  ${issues.filter(issue => issue.level === 'fail').length} 项失败 / ${issues.length} 项提示`,
  ], { color: verdict ? yellow : green })
  blank()
  return verdict ? 1 : 0
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
            { key: '1', label: '一键配置', hint: '接哪一家 → 选模型 → 写 Claude Code 配置 → 后台常驻' },
            { key: '2', label: '切换模型', hint: '改完自动重启服务' },
            { key: '3', label: '查看状态', hint: '登录有效期 / 服务 / 文件位置' },
          ],
        },
        {
          title: '维护',
          items: [
            { key: '4', label: '重新登录（换账号）', hint: '浏览器授权' },
            { key: '5', label: '自检', hint: '配置 / 登录 / 两条门禁，会真发请求' },
            { key: '0', label: '还原配置', hint: '移除本工具写入的键并卸载后台服务' },
            { key: 'Q', label: '退出', hint: '', danger: true },
          ],
        },
      ],
    })
    if (choice === 'Q') return 0
    if (choice === '1') await setupWizard()
    if (choice === '2') await switchModel()
    if (choice === '3') await statusFlow()
    if (choice === '4') await loginFlow()
    if (choice === '0') await uninstallFlow()
    // 不再要「按回车返回菜单」：这里从不清屏，动作的输出留在上面，
    // 下一轮 banner 只是往下追加 —— 那个停顿只是白按一次回车。
  }
}
