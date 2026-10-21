/**
 * 自检：把两条门禁的**事实**变成可执行的验证，而不是只写在文档里。
 *
 * 这个项目的功能内核压在两条别人家的规则上，它们都可能半夜变：
 *
 * 1. **OpenCode 免费档的报文形状门禁**（5 个头 / `ses_` 形状 / `stream:true` + 四个小写工具）
 *    —— 上游收紧时表现是 `FreeTierError`；
 * 2. **腾讯的内容风控字面量**（`x-anthropic-billing-header` 整行、身份句、
 *    gitStatus 的主分支句）—— 表现是 `400 + code 11128`。
 *
 * 所以这里不是「打个 /health 看活着没」，而是**主动重推一遍门禁**：先发一次完整形状
 * 确认能过，再逐项去掉一个要件，确认它**确实还是必填项**。这样上游一改，用户自己
 * 就能看出是哪一条失效了，而不是只拿到一句「国际版用不了」。
 *
 * @module src/doctor.mjs
 */

import { OPENCODE, OPENCODE_GO, applyFreeTierGate, goCredential, goKeyTail, projectId, requestId, sessionId, shapeHeaders } from './opencode.mjs'
import { SOURCES, needsLogin } from './sources.mjs'
import { hasGoCredential } from './opencode.mjs'
import { credentialStatus, ensureCredential } from './auth.mjs'
import { chat as buddyChat, listModels } from './buddy.mjs'
import { toOpenAiRequest } from './anthropic.mjs'
import { systemRewriterFor } from './fingerprint.mjs'
import { LEGACY_SERVICE_LABEL, claudeSettingsPath, currentCliPath, readInstallState, serviceCliPath, serviceState } from './install.mjs'
import { HOME_DIR, LEGACY_HOME_DIR, legacyHomeInUse } from './home.mjs'
import fs from 'node:fs'

// ── OpenCode 门禁 ───────────────────────────────────────────────────────────

const gateStub = name => ({
  type: 'function',
  function: {
    name,
    description: 'Reserved for the host runtime; do not call it.',
    parameters: { type: 'object', properties: { input: { type: 'string', description: 'Unavailable; do not use.' } } },
  },
})

/**
 * 会话形状的一个「故意错」版本：**尾段写成 26 位随机**（总长 38）。
 *
 * 这正是文档里警告过的那个坑 —— 官方 `id/index.ts` 的 `LENGTH = 26` 是尾段总长
 * （12 hex + 14 base62），当成随机段长度就会多出 12 位。
 *
 * ⚠️ 别用 `ses_` + 26 个 `0` 当反例：`0` 既是 hex 也是 base62，那个串**形状是对的**，
 * 假门禁与真上游都不会拒。
 */
const wrongSessionShape = () => `ses_${'0'.repeat(12)}${'A'.repeat(26)}`

async function probeOnce(fetchImpl, baseUrl, body, headers, timeoutMs, anonymousKey) {
  try {
    const response = await fetchImpl(`${baseUrl}${OPENCODE.chatPath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${anonymousKey}`, 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 正文一律读掉（免得挂着 socket），错误类型在**两条路**上都要认：上游偶尔用
    // 200 回一个错误信封，只看状态码会把那种响应当成「过了」。
    const text = await response.text()
    const errorType = /"(FreeTierError|AuthError|GoUsageLimitError|UsageLimitError)"/.exec(text)?.[1]
    if (response.ok && errorType === undefined) return { status: response.status, errorType: undefined, ok: true }
    return { status: response.status, errorType, ok: false, message: text.slice(0, 200) }
  } catch (error) {
    return { status: 0, errorType: undefined, ok: false, message: error?.message ?? String(error) }
  }
}

/** 上游用「403 + FreeTierError」表示报文形状没被认出来；两处文案都见过，所以两个判据都认。 */
const gateRejected = result => result.errorType === 'FreeTierError' || /free tier can only be used/i.test(result.message ?? '')

/**
 * 重推一遍 OpenCode 免费档的门禁。
 *
 * 完整形状应得 200；四个「去掉一个要件」的变体应被拒。哪一条变体**没被拒**，
 * 说明那一条已经不再是必填项（上游放松了）；完整形状被拒，说明上游收紧了。
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] 默认 `OPENCODE.baseUrl`；测试注入本机地址
 * @param {Function} [options.fetchImpl] 默认全局 `fetch`；测试注入假 fetch（离线）
 * @param {string} [options.anonymousKey] 默认 `OPENCODE.anonymousKey`（匿名档是字面量 `public`）
 */
export async function probeOpencodeGate({ baseUrl = OPENCODE.baseUrl, fetchImpl = fetch, timeoutMs = 20_000, anonymousKey = OPENCODE.anonymousKey } = {}) {
  const base = { model: OPENCODE.defaultModel, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const full = applyFreeTierGate({ ...base, tools: ['bash', 'glob', 'grep', 'read'].map(gateStub) })
  const project = projectId()
  const session = sessionId()
  const headers = shapeHeaders({ project, session, request: requestId() })
  const rows = []

  const complete = await probeOnce(fetchImpl, baseUrl, full.body, headers, timeoutMs, anonymousKey)
  // 四档：该过的过了 → pass；被门禁拒（上游收紧）→ fail；429 / 连不上 → 这一轮判不出来
  const tightened = gateRejected(complete)
  rows.push({
    label: '完整形状（5 个头 + 会话形状 + 四个工具 + stream）',
    required: true,
    verdict: complete.ok ? 'pass' : tightened ? 'fail' : 'inconclusive',
    ...complete,
  })
  if (!complete.ok) {
    // 只有明确是 FreeTierError 才叫「上游收紧了」；限流 / 网络不通是另一回事，
    // 混为一谈会把人引到错误的方向。
    return { baseUrl, rows, tightened, inconclusive: !tightened }
  }

  const { 'x-opencode-session-id': _omitted, ...withoutAlias } = headers
  const variants = [
    { label: '去掉 x-opencode-session-id', body: full.body, headers: withoutAlias },
    { label: '会话 id 尾段写成 26 位（总长 38）', body: full.body, headers: { ...headers, 'x-opencode-session': wrongSessionShape(), 'x-opencode-session-id': wrongSessionShape() } },
    { label: 'tools 里不带 bash/glob/grep/read', body: { ...base }, headers },
    { label: 'stream: false', body: { ...full.body, stream: false }, headers },
  ]
  for (const variant of variants) {
    const result = await probeOnce(fetchImpl, baseUrl, variant.body, variant.headers, timeoutMs, anonymousKey)
    rows.push({
      label: variant.label,
      // 该被拒却被放行 ⇒ relaxed：这一条已不再是必填项（上游放松，不影响使用，但文档要跟着改）
      // 被拒 ⇒ pass：这一条确实是必填项，事实仍然成立
      verdict: result.ok ? 'relaxed' : gateRejected(result) ? 'pass' : 'inconclusive',
      ...result,
    })
  }
  return { baseUrl, rows, tightened: false, relaxed: rows.filter(row => row.verdict === 'relaxed').map(row => row.label) }
}

/**
 * 重推 Go 套餐（认证通道）的三条事实：
 * 模型清单要 key、会话头必填、带上会话头能出字。
 *
 * 与免费档那条路的区别是这里**没有**形状门禁，所以探针也短：
 * 缺会话头应得 `400 MissingSessionID`，而不是 FreeTierError。
 */
export async function probeOpencodeGo(source = OPENCODE_GO, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const credential = goCredential()
  if (credential === undefined) return { configured: false, rows: [] }
  const rows = []
  const url = `${source.baseUrl}${source.chatPath}`
  const body = { model: source.defaultModel, stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }

  const call = async headers => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      return { status: response.status, ok: response.ok, message: response.ok ? '' : text.slice(0, 160) }
    } catch (error) {
      return { status: 0, ok: false, message: error?.message ?? String(error) }
    }
  }

  const auth = { authorization: `Bearer ${credential.apiKey}` }
  // 判定分三档，别把「判不出来」报成「这条路坏了」：
  //   pass         出字了
  //   fail         缺会话头（必填项这条事实被推翻）或凭据被拒 —— 都是真问题
  //   inconclusive 额度受限 / 上游 5xx / 连不上 —— 与门禁无关，别误导人去查会话头
  const verdictOf = (result, failPattern) => {
    if (result.ok) return 'pass'
    if (failPattern.test(result.message ?? '')) return 'fail'
    if (result.status === 0 || result.status === 429 || result.status >= 500) return 'inconclusive'
    return 'fail'
  }
  const withSession = await call({ ...auth, [source.sessionHeader]: credential.session })
  rows.push({
    label: `带 ${source.sessionHeader} 的一次最小对话`,
    verdict: verdictOf(withSession, /MissingSessionID/),
    ...withSession,
  })
  const withoutSession = await call(auth)
  rows.push({
    label: `不带 ${source.sessionHeader} 应被拒`,
    verdict: !withoutSession.ok && /MissingSessionID/.test(withoutSession.message) ? 'pass' : withoutSession.ok ? 'relaxed' : 'inconclusive',
    ...withoutSession,
  })
  const listing = await (async () => {
    try {
      const response = await fetchImpl(`${source.baseUrl}${source.modelsPath}`, { headers: auth, signal: AbortSignal.timeout(timeoutMs) })
      const payload = response.ok ? await response.json() : null
      return { status: response.status, ok: response.ok, count: Array.isArray(payload?.data) ? payload.data.length : 0 }
    } catch (error) {
      return { status: 0, ok: false, message: error?.message ?? String(error) }
    }
  })()
  rows.push({ label: '模型清单要 key', verdict: verdictOf(listing, /Unauthorized|Forbidden|invalid/i), ...listing })
  return { configured: true, tail: goKeyTail(), rows }
}

// ── 腾讯内容风控 ────────────────────────────────────────────────────────────

/** 三条已知的字面量判据，拼成一次最小请求：改写器该把它们全部处理掉。 */
const FINGERPRINT_PAYLOAD = [
  "You are Claude Code, Anthropic's official CLI for Claude",
  'Main branch (you will usually use this for PRs): main',
  'x-anthropic-billing-header: cc_version=2.1.301',
].join('\n')

/**
 * 用**本工具自己的翻译层 + 改写器**打一次真实上游：过不了就是 400 + 11128。
 *
 * 走真链路（而不是裸发一个请求）才有意义 —— 要验的正是「翻译 → 改写 → 发送」这一整套。
 *
 * @param {object} product 腾讯产品（`products.mjs` 的 CN / INTL）
 * @param {object} [options]
 * @param {object} [options.credential] 注入凭据；不给就读本机登录态（未登录 → 跳过并说明）
 * @param {object[]} [options.models] 注入模型清单；不给就真取
 * @param {Function} [options.chat] 发送那一步（默认 `buddy.mjs` 的 chat）。URL 与请求头由它
 *   负责，这里**不再写一份字面量** —— 曾经重复写 `/v1` 拼出 `/inference/v1/v1/…` 拿 404
 */
export async function probeTencentFingerprint(product, {
  log = () => {},
  signal,
  credential,
  models,
  chat = buddyChat,
} = {}) {
  let cred = credential
  if (cred === undefined) {
    try {
      cred = await ensureCredential(product, { log, signal })
    } catch (error) {
      // 未登录不是门禁问题：这一节跳过并说明，别让整份自检跟着报错
      return { ok: false, verdict: 'inconclusive', skipped: true, status: 0, message: `${product.label}未登录，跳过（${error.message}）` }
    }
  }
  const list = models ?? await listModels(product, cred, { log, signal })
  const meta = list.find(model => model.id.includes('deepseek-v4.1-flash')) ?? list[0]
  if (meta === undefined) return { ok: false, verdict: 'inconclusive', status: 0, message: '模型清单是空的，无法探针' }
  const request = {
    model: meta.id, max_tokens: 8, stream: true,
    system: FINGERPRINT_PAYLOAD,
    messages: [{ role: 'user', content: 'ping' }],
  }
  // 改写器按**带来源前缀**的模型 ID 挑（`cn/…` / `intl/…`）；`meta.id` 是上游目录里的
  // 裸 ID，拿它去问会永远拿到 undefined —— 那样子探针会把三条字面量原样发出去，
  // 于是每一次都撞 11128，被报成「风控规则失效」，而真实链路（前缀模型）其实是好的。
  const prefixed = `${product.id}/${meta.id}`
  const { body, error } = toOpenAiRequest(request, { model: meta.id, rewriteSystem: systemRewriterFor(prefixed, true) })
  if (error !== undefined) return { ok: false, verdict: 'inconclusive', status: 0, message: `翻译层出错：${error}` }
  const result = await chat(product, body, { model: meta.id, meta, signal, log })
  if (result.ok) {
    const text = await result.response.text()
    const status = result.response.status
    const { blocked, limited } = classifyTencentFailure(text)
    // 流内拦截是「HTTP 200 + 一帧 {code,msg}」：状态码好看，内容却一个字都没出
    if (blocked) return { ok: false, verdict: 'fail', status, message: text.slice(0, 200), blocked, limited }
    if (limited) return { ok: false, verdict: 'inconclusive', status, message: text.slice(0, 200), blocked, limited }
    return { ok: true, verdict: 'pass', status, message: text.slice(0, 120) }
  }
  const message = result.message ?? ''
  const { blocked, limited } = classifyTencentFailure(message)
  // 额度/频率受限时**这一轮根本没验证到改写器**：报成「指纹规则失效」会把人引得去翻规则，
  // 而实际只要等额度恢复。
  return { ok: false, verdict: blocked ? 'fail' : 'inconclusive', status: result.status, message: message.slice(0, 200), blocked, limited }
}

/**
 * 把上游的失败理由分成「风控拦下」和「额度/频率受限」。
 *
 * 这两者必须分开：额度受限时**这一轮根本没验证到改写器**，报成「指纹规则失效」
 * 会把人引到完全错误的方向（去翻规则，而实际只要等额度恢复）。
 */
export function classifyTencentFailure(message) {
  const text = String(message ?? '')
  // 「渠道校验」是 11128 的新说法（2026-10-21 实测：`request illegal` +
  // displayTips「这次调用没通过渠道校验」），照样算风控拦下。
  const blocked = /Illegal API invocation|unapproved channel|渠道校验|11128|请求被拦截/i.test(text)
  // `14018 Credits exhausted` 是国际版的额度耗尽：必须与风控分开报，否则会把人引去翻规则。
  const limited = !blocked && /频率限制|额度|超出|quota|rate limit|too many|Credits exhausted|14018/i.test(text)
  return { blocked, limited }
}

// ── 本地体检 ────────────────────────────────────────────────────────────────

/**
 * 本地配置的自洽性检查。
 *
 * 纯函数（喂进 settings / 服务环境 / 服务文件内容），便于离线断言 —— 这几条都是
 * 真实踩过的坑：密钥与服务不一致会 401、`model` 与 `ANTHROPIC_MODEL` 不一致会静默
 * 跑成另一个模型、服务指向全局安装快照会让 `git pull` 不生效。
 */
export function localIssues({ settings, serviceEnv, serviceCli, runningCli, healthOk, service, legacyHome }) {
  const issues = []
  const env = settings?.env ?? {}
  const ok = []

  // 改名（claude-code-openai-bridge → flow-one）留下的两处状态，都要说清怎么处理。
  // 「旧服务还在跑、新服务没装」尤其容易被误读成「没装服务却又能用」。
  if (service?.legacyInstalled === true && service?.installed !== true) {
    issues.push({
      level: 'warn',
      text: `改名前的旧服务 ${LEGACY_SERVICE_LABEL} 还装着（占着端口，新服务没装）`,
      fix: '跑一次「一键配置」会装成新名字并顺手清掉旧服务；只想清旧的：fo uninstall',
    })
  }
  if (legacyHome === true) {
    issues.push({
      level: 'warn',
      text: `数据目录还是改名前的 ~/${LEGACY_HOME_DIR}（照常用，登录态在里面）`,
      fix: `想搬到新名字：mv ~/${LEGACY_HOME_DIR} ~/${HOME_DIR}`,
    })
  }
  if (typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL !== '') ok.push(`BASE_URL ${env.ANTHROPIC_BASE_URL}`)
  else issues.push({ level: 'fail', text: 'settings.json 里没有 ANTHROPIC_BASE_URL —— Claude Code 不会走本桥', fix: '运行「一键配置」重写' })

  if (serviceEnv?.BRIDGE_API_KEY !== undefined && env.ANTHROPIC_AUTH_TOKEN !== serviceEnv.BRIDGE_API_KEY) {
    issues.push({ level: 'fail', text: 'settings.json 的密钥与服务的 BRIDGE_API_KEY 不一致（会 401）', fix: '运行「一键配置」对齐，或重装服务' })
  } else if (serviceEnv?.BRIDGE_API_KEY !== undefined) {
    ok.push('密钥与服务一致')
  }

  if (serviceEnv?.BRIDGE_PORT !== undefined && typeof env.ANTHROPIC_BASE_URL === 'string') {
    const port = /:(\d+)\s*$/.exec(env.ANTHROPIC_BASE_URL)?.[1]
    if (port !== undefined && port !== String(serviceEnv.BRIDGE_PORT)) {
      issues.push({ level: 'fail', text: `BASE_URL 的端口 ${port} 与服务端口 ${serviceEnv.BRIDGE_PORT} 不一致`, fix: '运行「一键配置」对齐' })
    }
  }

  const model = env.ANTHROPIC_MODEL
  if (typeof model === 'string' && model !== '' && settings?.model !== undefined && settings.model !== model) {
    issues.push({
      level: 'warn',
      text: `顶层 model（${settings.model}）与 ANTHROPIC_MODEL（${model}）不一致，可能静默跑成另一个模型`,
      fix: '运行「一键配置」重写（两个字段会写成同一个值）',
    })
  } else if (typeof model === 'string' && model !== '') {
    ok.push(`模型 ${model}`)
  }

  if (serviceCli !== undefined && runningCli !== undefined && serviceCli !== runningCli) {
    issues.push({
      level: 'fail',
      text: `服务跑的不是当前这份代码：${serviceCli}`,
      fix: '用当前这份代码重跑「一键配置」（全局安装是一份快照，git pull 不会更新它）',
    })
  } else if (serviceCli !== undefined) {
    ok.push('服务与当前命令是同一份代码')
  }

  if (healthOk === false) issues.push({ level: 'fail', text: '配置指向的端口上没有服务在跑（Claude Code 会 ECONNREFUSED）', fix: '运行「一键配置」并同意装成后台服务' })
  else if (healthOk === true) ok.push('/health 有应答')

  return { issues, ok }
}

/** 读真实机器状态，喂给 `localIssues`。 */
export function localSnapshot() {
  const settingsFile = claudeSettingsPath()
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch { /* 没有就是没配 */ }
  const state = readInstallState()
  const service = serviceState()
  return {
    settingsFile,
    settings,
    service,
    legacyHome: legacyHomeInUse(),
    serviceEnv: state?.service?.env,
    serviceCli: service.installed ? serviceCliPath() : undefined,
    runningCli: currentCliPath(),
  }
}

/** 登录状态检查（不联网）。 */
export function credentialChecks() {
  const rows = []
  for (const source of SOURCES) {
    if (!needsLogin(source)) {
      rows.push({ label: source.label, ok: true, text: '无需登录（匿名免费档）' })
      continue
    }
    if (source.auth === 'key') {
      rows.push(hasGoCredential()
        ? { label: source.label, ok: true, text: `已配置 API key（末四位 ${goKeyTail()}）` }
        : { label: source.label, ok: false, text: '未配置 API key', fix: '菜单「一键配置」里选 OpenCode Go 套餐填 key' })
      continue
    }
    const status = credentialStatus(source)
    if (!status.loggedIn) {
      rows.push({ label: source.label, ok: false, text: '未登录', fix: `fo login ${source.id}` })
      continue
    }
    const soon = status.expiresAt !== undefined && status.expiresAt - Date.now() < 7 * 24 * 3600 * 1000
    rows.push({
      label: source.label,
      ok: !soon,
      text: `${status.nickname === '' ? '已登录' : status.nickname}${status.expiresAt === undefined ? '' : ` · ${new Date(status.expiresAt).toLocaleDateString('zh-CN')} 到期`}`,
      ...soon ? { fix: '快到期了，跑一次 login 续期' } : {},
    })
  }
  return rows
}
