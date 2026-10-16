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

import { OPENCODE, applyFreeTierGate, projectId, requestId, sessionId, shapeHeaders } from './opencode.mjs'
import { SOURCES, needsLogin } from './sources.mjs'
import { credentialStatus, ensureCredential } from './auth.mjs'
import { chat as buddyChat, listModels } from './buddy.mjs'
import { toOpenAiRequest } from './anthropic.mjs'
import { systemRewriterFor } from './fingerprint.mjs'
import { claudeSettingsPath, currentCliPath, readInstallState, serviceCliPath, serviceState } from './install.mjs'
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

async function probeOnce(fetchImpl, baseUrl, body, headers, timeoutMs) {
  try {
    const response = await fetchImpl(`${baseUrl}${OPENCODE.chatPath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENCODE.anonymousKey}`, 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      // 只要不是错误信封就算过；顺便把连接读掉，避免挂着的 socket
      const text = await response.text()
      return { status: response.status, errorType: undefined, ok: !/FreeTierError|AuthError/.test(text) }
    }
    const text = await response.text()
    const type = /"(FreeTierError|AuthError|GoUsageLimitError|UsageLimitError)"/.exec(text)?.[1]
    return { status: response.status, errorType: type, ok: false, message: text.slice(0, 200) }
  } catch (error) {
    return { status: 0, errorType: undefined, ok: false, message: error?.message ?? String(error) }
  }
}

/**
 * 重推一遍 OpenCode 免费档的门禁。
 *
 * 完整形状应得 200；四个「去掉一个要件」的变体应被拒。哪一条变体**没被拒**，
 * 说明那一条已经不再是必填项（上游放松了）；完整形状被拒，说明上游收紧了。
 */
export async function probeOpencodeGate({ baseUrl = OPENCODE.baseUrl, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const base = { model: OPENCODE.defaultModel, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const full = applyFreeTierGate({ ...base, tools: ['bash', 'glob', 'grep', 'read'].map(gateStub) })
  const project = projectId()
  const session = sessionId()
  const headers = shapeHeaders({ project, session, request: requestId() })
  const rows = []

  const complete = await probeOnce(fetchImpl, baseUrl, full.body, headers, timeoutMs)
  rows.push({
    label: '完整形状（5 个头 + 会话形状 + 四个工具 + stream）',
    required: true,
    // 完整形状该过；过不了才是真问题
    verdict: complete.ok ? 'pass' : 'fail',
    ...complete,
  })
  if (!complete.ok) {
    // 只有明确是 FreeTierError 才叫「上游收紧了」；限流 / 网络不通是另一回事，
    // 混为一谈会把人引到错误的方向。
    const tightened = complete.errorType === 'FreeTierError' || /free tier can only be used/i.test(complete.message ?? '')
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
    const result = await probeOnce(fetchImpl, baseUrl, variant.body, variant.headers, timeoutMs)
    rows.push({
      label: variant.label,
      // 该被拒却被放行 ⇒ relaxed：这一条已不再是必填项（上游放松，不影响使用，但文档要跟着改）
      // 被拒 ⇒ pass：这一条确实是必填项，事实仍然成立
      verdict: result.ok ? 'relaxed' : result.errorType === 'FreeTierError' ? 'pass' : 'inconclusive',
      ...result,
    })
  }
  return { baseUrl, rows, tightened: false, relaxed: rows.filter(row => row.verdict === 'relaxed').map(row => row.label) }
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
 * 走真链路（而不是裸发一个请求）才有意义 —— 要验的正是「改写 + 发送」这一整套。
 */
export async function probeTencentFingerprint(product, { log = () => {}, signal } = {}) {
  const credential = await ensureCredential(product, { log })
  const models = await listModels(product, credential, { log })
  const meta = models.find(model => model.id.includes('deepseek-v4.1-flash')) ?? models[0]
  if (meta === undefined) return { ok: false, status: 0, message: '模型清单是空的，无法探针' }
  const request = {
    model: meta.id, max_tokens: 8, stream: true,
    system: FINGERPRINT_PAYLOAD,
    messages: [{ role: 'user', content: 'ping' }],
  }
  // 走**本工具自己的翻译层 + 改写器**：要验的正是「翻译 → 改写 → 发送」这一整套，
  // 裸发一个手工请求证明不了改写器在真实链路上生效。
  const body = toOpenAiRequest(request, { model: meta.id, rewriteSystem: systemRewriterFor(meta.id, true) })
  if (body.error !== undefined) return { ok: false, status: 0, message: `翻译层出错：${body.error}` }
  const result = await buddyChat(product, body, { model: meta.id, meta, signal, log })
  if (result.ok) {
    const text = await result.response.text()
    return { ok: true, status: result.response.status, message: text.slice(0, 120) }
  }
  const message = result.message ?? ''
  return { ok: false, status: result.status, message: message.slice(0, 200), ...classifyTencentFailure(message) }
}

/**
 * 把上游的失败理由分成「风控拦下」和「额度/频率受限」。
 *
 * 这两者必须分开：额度受限时**这一轮根本没验证到改写器**，报成「指纹规则失效」
 * 会把人引到完全错误的方向（去翻规则，而实际只要等额度恢复）。
 */
export function classifyTencentFailure(message) {
  const text = String(message ?? '')
  const blocked = /Illegal API invocation|unapproved channel|11128|请求被拦截/i.test(text)
  const limited = !blocked && /频率限制|额度|超出|quota|rate limit|too many/i.test(text)
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
export function localIssues({ settings, serviceEnv, serviceCli, runningCli, healthOk }) {
  const issues = []
  const env = settings?.env ?? {}
  const ok = []
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
    const status = credentialStatus(source)
    if (!status.loggedIn) {
      rows.push({ label: source.label, ok: false, text: '未登录', fix: `ccb login ${source.id}` })
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
