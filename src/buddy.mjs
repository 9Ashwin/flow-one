/**
 * 腾讯系产品客户端：模型目录与对话。
 *
 * 这两条请求的身份头是官方客户端的出站形态，缺一个都会被后台归因成 `-` 或直接
 * 拒绝，因此集中在这里构造：
 *
 * ```
 * 控制面：X-Domain / X-Product: SaaS / X-Product-Code / User-Agent / Authorization
 * 对话面：以上全部 + X-Agent-Purpose: conversation + X-IDE-Name/Type/Version
 * ```
 *
 * 两个容易踩的点，都在代码里标了出处：
 * - **`messages[0]` 必须是 system**。国际版网关对首条是 user 的请求直接回
 *   `400 + code 11128`，所以这里无条件补一条 system，而不是只在客户端给了才带。
 * - **`stream` 恒为 true**。这条上游没有非流式对话接口，`stream:false` 不是
 *   「一次性返回」而是失败。
 *
 * @module src/buddy.mjs
 */

import crypto from 'node:crypto'
import { ensureCredential } from './auth.mjs'
import { userAgentFor } from './products.mjs'

const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_SYSTEM = 'You are a helpful assistant.'
const ENTERPRISE_SCOPE = 'personal'
const PREFERRED_AGENTS = ['cli', 'craft']

function headersFor(product, credential, model) {
  const headers = {
    'X-Domain': product.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': product.productCode,
    'User-Agent': model === undefined ? product.userAgent : userAgentFor(product, model),
    Authorization: `Bearer ${credential.accessToken}`,
  }
  const enterpriseId = credential.account?.enterpriseId ?? ''
  if (enterpriseId !== '') {
    headers['X-Enterprise-Id'] = enterpriseId
    headers['X-Tenant-Id'] = enterpriseId
  }
  return headers
}

async function getJson(url, headers, signal) {
  const response = await fetch(url, { headers, signal: signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : signal })
  let body = null
  try { body = await response.json() } catch { /* 无体响应交给状态码判断 */ }
  return { status: response.status, body }
}

// ── 模型目录 ────────────────────────────────────────────────────────────────

function isAutoAlias(id) {
  return id === 'auto' || id === 'default'
}

/** 补全 / NES / 文生图这类条目不是对话模型，混进清单会让用户选中一个必然失败的 ID。 */
function isChatModel(id, meta) {
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.supportsExtra === true) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  if (Array.isArray(meta?.tags) && meta.tags.includes('text-to-image')) return false
  return true
}

function metaOf(record) {
  if (record === null || typeof record !== 'object') return {}
  const meta = {}
  if (typeof record.maxInputTokens === 'number' && record.maxInputTokens > 0) meta.contextWindow = record.maxInputTokens
  if (typeof record.maxOutputTokens === 'number' && record.maxOutputTokens > 0) meta.maxOutputTokens = record.maxOutputTokens
  if (typeof record.supportsImages === 'boolean') meta.supportsImages = record.supportsImages
  const reasoning = record.reasoning
  if (reasoning !== null && typeof reasoning === 'object') {
    if (Array.isArray(reasoning.supportedEfforts)) {
      const efforts = reasoning.supportedEfforts.filter(item => typeof item === 'string' && item !== '')
      if (efforts.length > 0) meta.efforts = efforts
    }
    if (typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== '') meta.defaultEffort = reasoning.defaultEffort
  }
  return meta
}

/** 试用横幅下发的模型既不在 agent 列表也不在 `data.models` 里，但实测可调用。 */
function trialModelIds(data) {
  const banners = data?.productFeaturesConfig?.ModelTrialBanner?.banners
  if (!Array.isArray(banners)) return []
  return banners.map(item => item?.targetModelId).filter(id => typeof id === 'string' && id !== '')
}

/**
 * 解析 `/v3/config` 与企业模型端点的响应。
 *
 * 顺序即优先级：主对话 agent（`cli` 或 `craft`）引用的模型排最前，其余
 * `data.models` 里的对话模型跟上，最后补试用横幅。两个端点的模型集合**不同**
 * （实测国内版 `/v3/config` 才有 `hy4-preview-f`），所以调用方会取并集。
 */
export function parseModels(body) {
  const data = body !== null && typeof body === 'object' ? body.data : undefined
  if (data === null || typeof data !== 'object') return []
  const metaById = new Map()
  if (Array.isArray(data.models)) {
    for (const model of data.models) {
      if (model !== null && typeof model === 'object' && typeof model.id === 'string') metaById.set(model.id, model)
    }
  }
  const parsed = []
  const seen = new Set()
  const push = id => {
    if (typeof id !== 'string' || id === '' || isAutoAlias(id) || seen.has(id)) return
    const meta = metaById.get(id)
    if (!isChatModel(id, meta)) return
    seen.add(id)
    const name = typeof meta?.name === 'string' && meta.name !== '' ? meta.name : id
    parsed.push({ id, name, ...metaOf(meta) })
  }
  const agents = Array.isArray(data.agents) ? data.agents : []
  for (const agentName of PREFERRED_AGENTS) {
    const agent = agents.find(item => item !== null && typeof item === 'object' && item.name === agentName)
    if (agent === undefined) continue
    for (const id of Array.isArray(agent.models) ? agent.models : []) push(id)
    break
  }
  for (const id of metaById.keys()) push(id)
  for (const id of trialModelIds(data)) push(id)
  return parsed
}

/**
 * 取模型目录：企业端点（元数据最全）优先，空或失败时回退 `/v3/config`，
 * 两层都拿不到才用产品兜底表。
 */
export async function listModels(product, credential, { signal, log = () => {} } = {}) {
  const headers = headersFor(product, credential)
  const scoped = await getJson(`${product.endpoint}/console/enterprises/${ENTERPRISE_SCOPE}/models`, headers, signal)
    .then(result => (result.status === 200 ? parseModels(result.body) : []))
    .catch(() => [])
  const config = await getJson(`${product.endpoint}/v3/config`, headers, signal)
    .then(result => (result.status === 200 ? parseModels(result.body) : []))
    .catch(() => [])
  const merged = [...scoped]
  const known = new Set(scoped.map(model => model.id))
  for (const model of config) if (!known.has(model.id)) merged.push(model)
  if (merged.length === 0) {
    log(`${product.label}：远端模型目录为空，使用内置兜底清单`)
    return product.fallbackModels.map(id => ({ id, name: id }))
  }
  return merged
}

// ── 对话 ────────────────────────────────────────────────────────────────────

/** 前缀缓存键：同一段 system 前缀稳定命中，实测同一请求的计费差约 17 倍。 */
export function cacheKeyFor(messages, model) {
  const system = messages.find(message => message.role === 'system')
  const seed = `${model}\u0000${typeof system?.content === 'string' ? system.content : ''}`
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)
}

/**
 * 把桥内部的 OpenAI 请求体改写成这条上游真正接受的形态。
 *
 * 已知不可用的字段在这里**去掉**而不是原样转发：官方客户端从不发 `tool_choice`
 * 与 `top_p`，转发一个没被验证过的参数只会换来一个 400。
 */
export function toBuddyBody(openAiBody, { meta, model }) {
  const messages = Array.isArray(openAiBody.messages) ? [...openAiBody.messages] : []
  // 国际版网关对首条不是 system 的请求回 400 + 11128。
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: DEFAULT_SYSTEM })
  }
  const body = {
    model,
    messages,
    stream: true,
    prompt_cache_key: cacheKeyFor(messages, model),
  }
  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) body.tools = openAiBody.tools
  if (typeof openAiBody.temperature === 'number') body.temperature = openAiBody.temperature
  if (Array.isArray(openAiBody.stop) && openAiBody.stop.length > 0) body.stop = openAiBody.stop

  const efforts = Array.isArray(meta?.efforts) ? meta.efforts : []
  const cap = typeof meta?.maxOutputTokens === 'number' && meta.maxOutputTokens > 0 ? meta.maxOutputTokens : 0
  const requested = Number(openAiBody.max_tokens)
  if (Number.isFinite(requested) && requested > 0) body.max_tokens = cap > 0 ? Math.min(Math.trunc(requested), cap) : Math.trunc(requested)
  else if (cap > 0) body.max_tokens = cap

  const deepseek = /deepseek/i.test(model)
  const wanted = typeof openAiBody.reasoning_effort === 'string' ? openAiBody.reasoning_effort : undefined
  if (wanted !== undefined && efforts.includes(wanted)) body.reasoning_effort = wanted
  if (deepseek) {
    // 实测：这一族模型只有 `reasoning_effort` 能打开思考，`thinking` 单独不生效，
    // 两个都带才稳定返回 reasoning_content。
    body.thinking = { type: 'enabled' }
    if (body.reasoning_effort === undefined && efforts.length > 0) {
      body.reasoning_effort = meta?.defaultEffort && efforts.includes(meta.defaultEffort)
        ? meta.defaultEffort
        : efforts.includes('high') ? 'high' : efforts[0]
    }
  }
  return body
}

/**
 * 发起一次对话请求。
 *
 * 令牌失效（401/403）时用 refresh token 静默续期并**重试一次** —— 长会话里
 * 令牌过期是常态，让用户因此丢一轮回答是不可接受的。
 */
export async function chat(product, openAiBody, { model, meta, signal, log = () => {}, file } = {}) {
  const wire = toBuddyBody(openAiBody, { meta, model })
  let credential = await ensureCredential(product, { log, signal, file })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${product.endpoint}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        ...headersFor(product, credential, model),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Agent-Purpose': 'conversation',
        'X-IDE-Name': product.attributionName,
        'X-IDE-Type': product.attributionName,
        'X-IDE-Version': product.clientVersion,
      },
      body: JSON.stringify(wire),
      signal: signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : signal,
    })
    if (response.ok) return { ok: true, response }
    let detail = ''
    try {
      const raw = await response.text()
      try {
        const payload = JSON.parse(raw)
        detail = payload?.msg ?? payload?.message ?? payload?.error?.message ?? raw.slice(0, 300)
      } catch {
        detail = raw.slice(0, 300)
      }
    } catch { /* 读不到正文就只用状态码 */ }
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      log(`${product.label}：令牌被拒（HTTP ${response.status}），正在续期后重试`)
      credential = await ensureCredential(product, { log, signal, file, force: true })
      continue
    }
    return { ok: false, status: response.status, message: detail === '' ? `上游返回 ${response.status}` : detail }
  }
  return { ok: false, status: 401, message: `${product.label}：登录已失效，请重新执行 login ${product.id}` }
}
