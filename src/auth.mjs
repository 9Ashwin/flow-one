/**
 * 腾讯系登录（国内版 CodeBuddy 与国际版 WorkBuddy 同一套 `/plugin` 协议）。
 *
 * 采用**外部链接轮询式**登录，不起本地回调服务器：
 *
 * ```
 * POST /v2/plugin/auth/state?platform=<platform>   → {state, authUrl}
 * 打开浏览器到 authUrl                                → 用户在网页上完成登录
 * GET  /v2/plugin/auth/token?state=<state>          → 轮询拿 accessToken（1s 间隔，5 分钟超时）
 * GET  /v2/plugin/login/account?state=<state>       → 轮询拿账号（uid / 昵称 / 企业 id）
 * POST /v2/plugin/auth/token/refresh                → 之后静默续期
 * ```
 *
 * 未就绪的两个错误码必须当成「继续等」而不是失败：`11217`（token 未就绪）、
 * `12151`（账号信息未完成）—— 把它们当错误会让登录在第一秒就失败。
 *
 * 凭据落在 `~/.claude-code-openai-bridge/credentials.json`（0600），与 DSH 或
 * 官方客户端的数据目录互不干扰。
 *
 * @module src/auth.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { credentialFile } from './config.mjs'

const STATE_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 1000
/** 到期前多久开始续期：留出一次网络往返的余量。 */
const REFRESH_MARGIN_MS = 120_000

const CODE_TOKEN_NOT_READY = 11217
const CODE_ACCOUNT_NOT_READY = 12151

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() })

/** 凭据文件的位置与 `config.credentialFile` 同源，测试可整体改道 BRIDGE_HOME。 */
export function storePath(env = process.env, home) {
  return credentialFile(env, home)
}

export function readStore(file = storePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(data, file = storePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function saveCredential(product, credential, file = storePath()) {
  writeStore({ ...readStore(file), [product.id]: credential }, file)
}

export function dropCredential(product, file = storePath()) {
  const data = readStore(file)
  delete data[product.id]
  writeStore(data, file)
}

// ── 报文读取 ────────────────────────────────────────────────────────────────

function dataOf(body) {
  return body !== null && typeof body === 'object' ? body.data : undefined
}

function codeOf(body) {
  const value = body !== null && typeof body === 'object' ? body.code : undefined
  return typeof value === 'number' ? value : undefined
}

function messageOf(body) {
  if (body === null || typeof body !== 'object') return ''
  for (const key of ['msg', 'message', 'displayMsg', 'errorMsg']) {
    const value = body[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function text(value) {
  if (typeof value === 'string') return value.replace(/[\r\n\t]+/g, ' ').trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 超时 + 外部取消合成一个信号。
 *
 * 不用 `AbortSignal.any`：那是 Node 20.3 才有的 API，而本项目的底线是 Node 18。
 */
function withTimeout(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted || timeout.aborted) abort()
  else {
    signal.addEventListener('abort', abort, { once: true })
    timeout.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

async function control(method, url, headers, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
  const response = await fetch(url, { method, headers, signal: withTimeout(timeoutMs, signal) })
  let body = null
  try { body = await response.json() } catch { /* 空体或非 JSON：交给状态码判断 */ }
  return { status: response.status, body }
}

/** 后端可能把过期时间给成毫秒、秒或 ISO 字符串，统一成毫秒。 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (/^\d+$/.test(value.trim())) return toEpochMs(Number(value.trim()))
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 令牌本身携带 exp；服务端没下发过期时间时以它为准。 */
function jwtClaim(token, claim) {
  const parts = String(token).split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const value = payload?.[claim]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function parseToken(data) {
  const record = data !== null && typeof data === 'object' ? data : {}
  const accessToken = text(record.accessToken)
  const expiresAt = toEpochMs(record.expiresAt)
    ?? relativeEpoch(record.expiresIn)
    ?? jwtEpoch(accessToken, 'exp')
  const refreshExpiresAt = toEpochMs(record.refreshExpiresAt) ?? relativeEpoch(record.refreshExpiresIn)
  return {
    accessToken,
    refreshToken: text(record.refreshToken),
    tokenType: text(record.tokenType) || 'Bearer',
    domain: text(record.domain),
    ...expiresAt === undefined ? {} : { expiresAt },
    ...refreshExpiresAt === undefined ? {} : { refreshExpiresAt },
  }
}

/** `expiresIn` 是「还能用多少秒」的相对值，基准是现在。 */
function relativeEpoch(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined
}

/** 令牌 JWT 里的 exp 是权威过期时刻，服务端没下发绝对时间时用它兜底。 */
function jwtEpoch(token, claim) {
  const seconds = jwtClaim(token, claim)
  return seconds === undefined ? undefined : seconds * 1000
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/** 没有 `open` 命令的机器（SSH、容器）只打印链接，不当作失败。 */
export function openInBrowser(url, log = () => {}) {
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    child.on('error', () => log(`无法自动打开浏览器，请手动访问：${url}`))
    child.unref()
  } catch {
    log(`无法自动打开浏览器，请手动访问：${url}`)
  }
}

/**
 * 国际版登录链接要带 `version` 与 `loginSessionId`（后者仅是服务端日志追踪用的
 * UUID，实测无校验语义）。只追加参数，路径与 state 一律用服务端下发的那份。
 */
function decorateLoginUrl(authUrl, product) {
  if (!product.sessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    if (product.pluginVersion !== undefined) url.searchParams.set('version', product.pluginVersion)
    url.searchParams.set('loginSessionId', crypto.randomUUID())
    return url.toString()
  } catch {
    return authUrl
  }
}

export async function fetchAuthState(product, options = {}) {
  const url = `${product.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(product.platform)}`
  const { status, body } = await control('POST', url, {
    'X-Domain': product.apiDomain,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': product.userAgent,
  }, { timeoutMs: STATE_TIMEOUT_MS, signal: options.signal })
  if (status !== 200) throw new Error(`${product.label}：获取登录地址失败（HTTP ${status} ${messageOf(body)}）`)
  const data = dataOf(body)
  const state = text(data?.state)
  const authUrl = text(data?.authUrl)
  if (state === '' || authUrl === '') throw new Error(`${product.label}：登录地址响应缺少 state 或 authUrl`)
  return { state, authUrl }
}

async function pollToken(product, state, options) {
  const url = `${product.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`
  const headers = { 'X-No-Authorization': 'true', 'User-Agent': product.userAgent }
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(POLL_INTERVAL_MS)
    let result
    try {
      result = await control('GET', url, headers, { signal: options.signal })
    } catch {
      continue // 网络抖动不该中断整个登录
    }
    if (result.status === 200 && dataOf(result.body) !== undefined && dataOf(result.body) !== null) {
      const token = parseToken(dataOf(result.body))
      if (token.accessToken !== '') return token
      continue
    }
    if (codeOf(result.body) === CODE_TOKEN_NOT_READY) continue
    throw new Error(`${product.label}：获取令牌失败（HTTP ${result.status} code=${codeOf(result.body) ?? '-'}）`)
  }
  throw new Error(`${product.label}：登录超时（5 分钟内未在浏览器完成授权）`)
}

async function pollAccount(product, state, token, options) {
  const url = `${product.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`
  const headers = {
    // 登录流程里 domain 是服务端**本次刚下发**的权威值，非空时以它为准。
    'X-Domain': token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'User-Agent': product.userAgent,
  }
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(POLL_INTERVAL_MS)
    let result
    try {
      result = await control('GET', url, headers, { signal: options.signal })
    } catch {
      continue
    }
    const data = dataOf(result.body)
    if (result.status === 200 && data !== undefined && data !== null) {
      return {
        uid: text(data.uid),
        nickname: text(data.nickname),
        enterpriseId: text(data.enterpriseId),
        accountType: text(data.type) || 'personal',
      }
    }
    if (codeOf(result.body) === CODE_ACCOUNT_NOT_READY) continue
    // 账号信息拿不到不该让整次登录白费：令牌已经在手，昵称只是展示项。
    if (result.status === 200 || result.status === 404) return undefined
    throw new Error(`${product.label}：获取账号信息失败（HTTP ${result.status} code=${codeOf(result.body) ?? '-'}）`)
  }
  return undefined
}

/** 完整登录：取 state → 用户浏览器授权 → 轮询令牌 → 轮询账号。 */
export async function login(product, { log = () => {}, openBrowser = openInBrowser, signal, file = storePath() } = {}) {
  log(`${product.label}：正在获取登录地址……`)
  const { state, authUrl } = await fetchAuthState(product, { signal })
  const url = decorateLoginUrl(authUrl, product)
  log(`${product.label}：请在浏览器中完成登录：\n  ${url}`)
  openBrowser(url, log)
  log(`${product.label}：等待授权（最长 5 分钟）……`)
  const token = await pollToken(product, state, { signal })
  const account = await pollAccount(product, state, token, { signal })
  const credential = { ...token, ...account === undefined ? {} : { account } }
  saveCredential(product, credential, file)
  log(`${product.label}：登录成功${account?.nickname ? `（${account.nickname}）` : ''}，凭据已保存`)
  return credential
}

// ── 续期 ────────────────────────────────────────────────────────────────────

export async function refreshCredential(product, credential, { signal, file = storePath() } = {}) {
  if (text(credential?.refreshToken) === '') {
    throw new Error(`${product.label}：凭据里没有 refresh token，请重新执行 login`)
  }
  const { status, body } = await control('POST', `${product.endpoint}/v2/plugin/auth/token/refresh`, {
    'X-Domain': product.apiDomain,
    'User-Agent': product.userAgent,
    Authorization: `Bearer ${credential.accessToken}`,
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'ide-main',
  }, { signal })
  if (status !== 200) {
    const message = messageOf(body)
    const expired = status === 401 || status === 403 || /expired|invalid/i.test(message)
    throw new Error(`${product.label}：${expired ? '登录已失效，请重新执行 login' : `续期失败（HTTP ${status} ${message}）`}`)
  }
  const data = dataOf(body)
  if (data === undefined || data === null) throw new Error(`${product.label}：续期响应缺少 data`)
  const refreshed = { ...parseToken(data), ...credential.account === undefined ? {} : { account: credential.account } }
  saveCredential(product, refreshed, file)
  return refreshed
}

/**
 * 取一份可用凭据：快到期就先续期，续期失败按「需要重新登录」报错。
 *
 * `force` 用于「上游刚回 401」这种令牌看着没过期、实际已被拒的情形。
 * 这个函数是所有对外请求的唯一入口，所以「令牌过期」这件事在整条链路上只处理一次。
 */
export async function ensureCredential(product, { log = () => {}, signal, file = storePath(), refresh = true, force = false } = {}) {
  const stored = readStore(file)[product.id]
  if (stored === undefined || text(stored.accessToken) === '') {
    throw Object.assign(new Error(`${product.label}：尚未登录，请先执行：claude-code-bridge login ${product.id}`), { statusCode: 401 })
  }
  const expiresAt = Number(stored.expiresAt)
  const expiring = Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_MARGIN_MS
  if (!refresh || (!force && !expiring)) return stored
  log(`${product.label}：令牌即将过期，正在续期……`)
  try {
    return await refreshCredential(product, stored, { signal, file })
  } catch (error) {
    throw Object.assign(new Error(error.message), { statusCode: 401 })
  }
}

/** 供 `status` 子命令展示；不发起任何网络请求。 */
export function credentialStatus(product, { file = storePath() } = {}) {
  const stored = readStore(file)[product.id]
  if (stored === undefined || text(stored.accessToken) === '') return { product: product.id, loggedIn: false }
  const expiresAt = Number(stored.expiresAt)
  return {
    product: product.id,
    label: product.label,
    loggedIn: true,
    nickname: stored.account?.nickname ?? '',
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    expiresInMs: Number.isFinite(expiresAt) ? expiresAt - Date.now() : undefined,
    refreshable: text(stored.refreshToken) !== '',
  }
}
