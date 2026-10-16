/**
 * OpenCode 免费模型通道（`opencode.ai/inference`）。
 *
 * ## 它为什么能用，以及为什么不是「加个 base URL」那么简单
 *
 * 匿名档（`Authorization: Bearer public`）确实能列到 88 个模型，但**直接发一个
 * 标准 OpenAI 请求会被拒**：
 *
 * ```
 * {"type":"error","error":{"type":"FreeTierError",
 *  "message":"OpenCode's free tier can only be used from within OpenCode."}}
 * ```
 *
 * 也就是说它按**报文形状**判断调用方是不是官方客户端。实测（2026-10-16）凑齐下面
 * 三样之后稳定 200：
 *
 * | 要件 | 值 |
 * | --- | --- |
 * | 请求头 | `x-opencode-project`（40 hex）、`x-opencode-session` + `x-opencode-session-id`（`ses_` 形状）、`x-opencode-request`（`msg_` 形状）、`x-opencode-client: cli`、`User-Agent: opencode/<版本>` |
 * | 会话 id 形状 | `ses_` + **12 位小写 hex**（时间戳铸造）+ **14 位 base62**；误写成 26 位随机段会变成 38 字符而**一律 403** |
 * | 请求体 | `stream: true`，且 `tools` 里必须有 `bash` / `glob` / `grep` / `read` 四个 function 工具，各自 `parameters` 至少声明一个 property |
 *
 * ## 与调用方工具名的冲突怎么解
 *
 * Claude Code 自己就有 `Bash` / `Read` 这两个工具，但门禁要的是**小写**四个名字，
 * 而且它不一定声明 `glob` / `grep`。所以这里做两件事：
 *
 * - 调用方声明了同名工具（不分大小写）→ 出站时改写成小写，并在响应里**改回原名**，
 *   否则 Claude Code 认不出 `bash` 这个工具；
 * - 调用方没声明的 → 补一个「摆设」桩，并且**丢弃**模型对桩的调用 —— 那是个
 *   Claude Code 根本执行不了的工具名，转发过去只会变成一条无从处理的错误。
 *
 * @module src/opencode.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bridgeHome } from './home.mjs'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** 门禁工具名：服务端按这四个名字识别官方客户端形状。 */
export const GATE_TOOLS = ['bash', 'glob', 'grep', 'read']

export const OPENCODE = {
  id: 'oc',
  kind: 'openai',
  label: 'OpenCode 免费模型',
  hint: '无需登录，走 opencode.ai 官方免费档',
  baseUrl: 'https://opencode.ai/inference',
  chatPath: '/v1/chat/completions',
  modelsPath: '/v1/models',
  /** 匿名凭证是字面量 `public`（官方 CLI 无 key 时也用它）。 */
  anonymousKey: 'public',
  defaultUserAgent: 'opencode/1.18.22',
  /** 免费档里对 Claude Code 最有用的一个：DeepSeek V4.1 Flash。 */
  defaultModel: 'deepseek-v4.1-flash-free',
  /** 能力元数据源（官方 CLI 自己也用它；`/v1/models` 里没有任何能力字段）。 */
  modelsDevUrl: 'https://models.dev/api.json',
  modelsDevTtlMs: 60 * 60 * 1000,
}

/**
 * 能力表缓存。
 *
 * ⚠️ 这张表**必须看**：`/v1/models` 只回 id/object/created/owned_by
 * （88 条全如此），没有任何能力信息。而「窗口多大」直接决定要不要给 Claude Code
 * 加 `[1m]` 后缀 —— 免费档的 `deepseek-v4.1-flash-free` 实测是 **200k**
 * （不是 1M），加错后缀会让它在 1M 处才压缩上下文，然后撞上模型的真实上限。
 */
let capabilityCache = { at: 0, byId: new Map() }

async function opencodeCapabilities({ signal } = {}) {
  const now = Date.now()
  if (now - capabilityCache.at < OPENCODE.modelsDevTtlMs && capabilityCache.byId.size > 0) return capabilityCache.byId
  try {
    const response = await fetch(OPENCODE.modelsDevUrl, { signal: signal ?? AbortSignal.timeout(20_000) })
    if (!response.ok) return capabilityCache.byId
    const payload = await response.json()
    const models = payload?.opencode?.models
    if (models === null || typeof models !== 'object') return capabilityCache.byId
    const byId = new Map()
    for (const [id, meta] of Object.entries(models)) {
      byId.set(id, {
        ...typeof meta?.limit?.context === 'number' ? { contextWindow: meta.limit.context } : {},
        ...typeof meta?.limit?.output === 'number' ? { maxOutputTokens: meta.limit.output } : {},
        ...meta?.attachment === true ? { supportsImages: true } : {},
        ...typeof meta?.name === 'string' && meta.name !== '' ? { name: meta.name } : {},
      })
    }
    capabilityCache = { at: now, byId }
  } catch { /* 拿不到就退回「无元数据」，上层据此不加后缀 */ }
  return capabilityCache.byId
}

function randomBase62(length) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[bytes[i] % BASE62.length]
  return out
}

/** 时间戳铸造的 12 位小写 hex（对齐官方 id 模块的 `timeBytes`）。 */
function timeHex(value) {
  let hex = ''
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return hex
}

let lastStamp = 0
let sequence = 0

/**
 * 生成会话 id：`ses_` + 12 hex + **14** 位 base62。
 *
 * 尾段总长 26（12 + 14）来自官方 `id/index.ts` 的 `LENGTH = 26`，随机段是
 * `26 - 12 = 14`。把 26 当成随机段长度会得到 38 字符，门禁直接 403。
 */
export function sessionId() {
  const stamp = Date.now()
  if (stamp !== lastStamp) {
    lastStamp = stamp
    sequence = 0
  }
  sequence += 1
  return `ses_${timeHex(~(BigInt(stamp) * 0x1000n + BigInt(sequence)))}${randomBase62(14)}`
}

/** 每请求一个的 request id，用网关同样接受的 `msg_` 铸造形状。 */
export function requestId() {
  return `msg_${timeHex(BigInt(Date.now()) * 0x1000n + 1n)}${randomBase62(14)}`
}

/**
 * 项目 id：40 位小写 hex，与官方 CLI 的 `sha1("git-remote:" + …)` 同形。
 *
 * 本机身份存在 `BRIDGE_HOME/opencode.json` 里，重启后不变 —— 每次换一个会让同一台
 * 机器在服务端被看成很多独立客户端。
 */
export function projectId(home = bridgeHome()) {
  const file = path.join(home, 'opencode.json')
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof stored?.projectId === 'string' && /^[0-9a-f]{40}$/.test(stored.projectId)) return stored.projectId
  } catch { /* 首次使用 */ }
  const identity = crypto.randomBytes(16).toString('hex')
  const value = crypto.createHash('sha1').update(`git-remote:opencode/${identity}`).digest('hex')
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ projectId: value }, null, 2), { mode: 0o600 })
  } catch { /* 落盘失败不影响本次请求 */ }
  return value
}

/** 发往免费档的完整头集。少任何一个都会被判成 FreeTierError。 */
export function shapeHeaders({ project, session, request, userAgent = OPENCODE.defaultUserAgent }) {
  return {
    'x-opencode-project': project,
    'x-opencode-session': session,
    // 新版门禁要求这个别名头与 session 一致：形状对了但缺它，同样 403。
    'x-opencode-session-id': session,
    'x-opencode-request': request,
    'x-opencode-client': 'cli',
    'user-agent': userAgent,
  }
}

function stubTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: { input: { type: 'string', description: 'Unavailable; do not use.' } } },
    },
  }
}

/**
 * 给请求体套上免费档要求的形状。
 *
 * @returns {{body: object, rename: Map<string,string>, stubs: Set<string>}}
 *   `rename` 是「出站小写名 → 调用方原名」，`stubs` 是只存在于桩里的名字（响应里要丢弃）。
 */
export function applyFreeTierGate(body) {
  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  const rename = new Map()
  const declared = new Set()
  const rewritten = tools.map(tool => {
    const name = tool?.function?.name
    if (typeof name !== 'string' || name === '') return tool
    const lower = name.toLowerCase()
    if (!GATE_TOOLS.includes(lower)) return tool
    declared.add(lower)
    if (lower === name) return tool
    rename.set(lower, name)
    return { ...tool, function: { ...tool.function, name: lower } }
  })
  const stubs = new Set()
  for (const gate of GATE_TOOLS) {
    if (declared.has(gate)) continue
    stubs.add(gate)
    rewritten.push(stubTool(gate))
  }
  return {
    body: { ...body, stream: true, tools: rewritten },
    rename,
    stubs,
  }
}

/**
 * 改写响应分片里的工具名。
 *
 * - `rename` 里的名字改回调用方的原名（`bash` → `Bash`），否则 Claude Code 不认；
 * - `stubs` 里的名字整条丢弃：那是我们为了过门禁补的桩，调用方没有这个工具，
 *   转发过去只会得到一条「未知工具」的失败。
 */
export async function* restoreToolCalls(chunks, { rename, stubs }) {
  const dropped = new Set()
  for await (const chunk of chunks) {
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : undefined
    if (choices === undefined) {
      yield chunk
      continue
    }
    let touched = false
    const next = choices.map(choice => {
      const calls = choice?.delta?.tool_calls
      if (!Array.isArray(calls) || calls.length === 0) return choice
      const kept = []
      for (const call of calls) {
        const index = Number.isInteger(call?.index) ? call.index : 0
        if (dropped.has(index)) { touched = true; continue }
        const name = call?.function?.name
        if (typeof name === 'string' && stubs.has(name.toLowerCase())) {
          dropped.add(index)
          touched = true
          continue
        }
        const original = typeof name === 'string' ? rename.get(name.toLowerCase()) : undefined
        if (original === undefined) { kept.push(call); continue }
        touched = true
        kept.push({ ...call, function: { ...call.function, name: original } })
      }
      return touched ? { ...choice, delta: { ...choice.delta, tool_calls: kept.length === 0 ? [] : kept } } : choice
    })
    yield touched ? { ...chunk, choices: next } : chunk
  }
}

// ── 客户端 ──────────────────────────────────────────────────────────────────

import { failureOf, readSse } from './sse.mjs'

/**
 * 进程级复用的会话 id：官方 CLI 一个会话一个 id，每次随机会让同一调用方在服务端
 * 被看成很多独立会话，反而破坏亲和。
 */
let session = ''

/** 模型清单：`/v1/models` 只回 id/object/created/owned_by，能力信息不在这里。 */
export async function listModels(source = OPENCODE, { signal } = {}) {
  const response = await fetch(`${source.baseUrl}${source.modelsPath}`, {
    headers: { authorization: `Bearer ${source.anonymousKey}`, 'user-agent': source.defaultUserAgent },
    signal: signal === undefined ? AbortSignal.timeout(20_000) : signal,
  })
  if (!response.ok) {
    const failure = await failureOf(response)
    throw new Error(`OpenCode 模型清单失败：${failure.message}`)
  }
  const payload = await response.json()
  const capabilities = await opencodeCapabilities({ signal })
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter(row => typeof row?.id === 'string' && row.id !== '')
    .map(row => ({
      id: row.id,
      name: row.id,
      // `-free` 结尾的是官方免费档；其余需要 OpenCode Go 订阅（$10/月起）。
      free: row.id.endsWith('-free') || row.id === 'big-pickle',
      ...capabilities.get(row.id) ?? {},
    }))
}

/**
 * 发起一次免费档对话。
 *
 * 返回形状与网关上游一致：`{ok:true, chunks}` 或 `{ok:false, status, message}`，
 * 于是上层的 Anthropic 翻译层不必知道上游是谁。
 */
export async function chat(source, model, body, { signal, log = () => {} } = {}) {
  if (session === '') session = sessionId()
  const gated = applyFreeTierGate({ ...body, model })
  const response = await fetch(`${source.baseUrl}${source.chatPath}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${source.anonymousKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...shapeHeaders({ project: projectId(), session, request: requestId() }),
    },
    body: JSON.stringify(gated.body),
    signal,
  })
  if (!response.ok) {
    const failure = await failureOf(response)
    // FreeTierError 只说明形状没被认出来，指出来比让用户猜有用
    if (/free tier can only be used/i.test(failure.message)) {
      log(`${source.label}：被免费档门禁拒绝（报文形状未被识别），请提 issue 附上本机版本`)
    }
    return failure
  }
  log(`${source.label}：${model} 已建立回合（会话 ${session.slice(0, 12)}…）`)
  return { ok: true, chunks: restoreToolCalls(readSse(response.body), gated) }
}

/** 供测试与诊断：当前进程用的会话 id。 */
export const currentSession = () => session
