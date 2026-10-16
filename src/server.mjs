/**
 * 本地反代服务：Anthropic Messages 进门，OpenAI 分片流出门。
 *
 * 路由：
 * - `POST /v1/messages`（含 `/messages`、`?beta=true`）流式与非流式
 * - `POST /v1/messages/count_tokens` 本地估算
 * - `GET  /v1/models` 上游清单（带产品前缀）
 * - `GET  /health`
 *
 * 三个刻意的行为：
 * - **上游先答，再发响应头**。上游的 401/429/400 因此能以真实状态码回给
 *   Claude Code，而不是先发一个 200 再在流里道歉。
 * - **静默期发 `ping` 帧**。推理模型可以先想 70 秒不吐字，客户端读不到任何
 *   字节就会把「还在想」当成「连接断了」。
 * - **模型名兜底**。Claude Code 发来的是 Claude 的模型名，而上游认的是
 *   `cn/deepseek-v4.1-flash` 这类 ID；映射不上就落到默认模型，会话照常可用。
 *
 * @module src/server.mjs
 */

import http from 'node:http'
import crypto from 'node:crypto'
import {
  anthropicMessage, createOutcome, createStreamTranslator, errorBody, estimateInputTokens, foldChunk, toOpenAiRequest,
} from './anthropic.mjs'
import { systemRewriterFor } from './fingerprint.mjs'

const MAX_BODY_BYTES = 32 * 1024 * 1024
const MODEL_TTL_MS = 60_000

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  529: 'overloaded_error',
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function anthropicError(res, status, message, type = ERROR_TYPES[status] ?? 'api_error') {
  json(res, status, errorBody(type, message))
}

/** 定长比较，避免用密钥前缀泄漏出「猜对了多少位」。 */
function keyMatches(provided, expected) {
  if (typeof expected !== 'string' || expected === '') return true
  const a = Buffer.from(String(provided ?? ''), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function providedKey(req) {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体超过 32 MiB'), { statusCode: 413 })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('请求体不是合法的 JSON'), { statusCode: 400 })
  }
}

export function createBridgeServer({ config, upstream, log = () => {} }) {
  const known = new Set()
  let modelsFetchedAt = 0
  let refreshing

  async function refreshModels() {
    if (refreshing !== undefined) return refreshing
    refreshing = upstream.loadModels()
      .then(rows => {
        known.clear()
        for (const row of rows) if (typeof row?.id === 'string' && row.id !== '') known.add(row.id)
        modelsFetchedAt = Date.now()
      })
      .catch(error => { log(`模型清单读取失败：${error?.message ?? error}`) })
      .finally(() => { refreshing = undefined })
    return refreshing
  }

  /** 上游认这个 ID 就原样透传，否则落到默认模型——Claude 的模型名一律走兜底。 */
  async function resolveModel(requested) {
    // Claude Code 的 `[1m]` 后缀理论上会在发请求前剥掉（实测 2.1.301 会），
    // 但把它当成「上游模型名的一部分」去查表只会白掉一次兜底，索性在这里去掉。
    const raw = typeof requested === 'string' ? requested.trim().replace(/\[[^\]]*\]$/, '') : ''
    const wanted = raw
    if (wanted !== '' && config.modelMap[wanted] !== undefined) return config.modelMap[wanted]
    if (wanted !== '' && known.has(wanted)) return wanted
    if (Date.now() - modelsFetchedAt > MODEL_TTL_MS || known.size === 0) await refreshModels()
    if (wanted !== '' && known.has(wanted)) return wanted
    if (config.model !== '') return config.model
    // 直连模式下「默认模型」由登录后的模型清单决定，顺序取第一个（国内版优先）。
    const first = [...known][0]
    if (first !== undefined) return first
    throw Object.assign(new Error('上游没有任何可用模型：请先执行 login，或用 --model 指定一个模型 ID'), { statusCode: 400 })
  }

  async function handleMessages(req, res, body) {
    const started = Date.now()
    const inputTokens = estimateInputTokens(body)
    const model = await resolveModel(body?.model)
    const translated = toOpenAiRequest(body, {
      model,
      maxTokensCap: config.maxTokensCap,
      // 腾讯后端会拦下自称是别的客户端的系统提示，只对腾讯系模型做窄改写。
      rewriteSystem: systemRewriterFor(model, config.fingerprintRewrite),
    })
    if (translated.error !== undefined) {
      anthropicError(res, 400, translated.error)
      return
    }
    const wantsStream = body?.stream === true
    const id = `msg_${crypto.randomBytes(12).toString('hex')}`
    const controller = new AbortController()
    res.once('close', () => controller.abort())

    const result = await upstream.chat(translated.body, { signal: controller.signal })
    if (result.ok !== true) {
      anthropicError(res, result.status ?? 502, result.message)
      return
    }

    if (!wantsStream) {
      const outcome = createOutcome()
      for await (const chunk of result.chunks) foldChunk(outcome, chunk)
      if (outcome.error !== undefined) {
        anthropicError(res, 502, outcome.error)
        return
      }
      json(res, 200, anthropicMessage(outcome, { model, id, inputTokens, showThinking: config.showThinking }))
      log(`messages model=${model} stream=0 ms=${Date.now() - started} out=${outcome.text.length}`)
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let heartbeat
    if (config.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n')
      }, config.heartbeatMs)
      heartbeat.unref?.()
    }
    const translator = createStreamTranslator({
      model, id, inputTokens, showThinking: config.showThinking,
      write: frame => { if (!res.writableEnded) res.write(frame) },
    })
    try {
      for await (const chunk of result.chunks) {
        if (!translator.push(chunk)) break
      }
      if (translator.failure !== undefined) translator.fail(translator.failure)
      else translator.end()
    } catch (error) {
      // 响应头已经发出去了，只能用流内 error 事件交代失败。
      translator.fail(controller.signal.aborted ? '客户端已断开' : error?.message ?? String(error))
    } finally {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
      const usage = translator.usage
      log(`messages model=${model} stream=1 ms=${Date.now() - started} in=${usage.input_tokens} out=${usage.output_tokens}`)
    }
  }

  async function handle(req, res) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'

    if (path === '/health') {
      json(res, 200, {
        ok: true, service: 'flow-one',
        upstream: upstream.describe(), models: known.size, model: config.model,
      })
      return
    }
    if (!keyMatches(providedKey(req), config.apiKey)) {
      anthropicError(res, 401, 'missing or invalid API key', 'authentication_error')
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (Date.now() - modelsFetchedAt > MODEL_TTL_MS || known.size === 0) await refreshModels()
      const ids = [...known]
      json(res, 200, {
        object: 'list',
        data: (ids.length > 0 ? ids : config.model === '' ? [] : [config.model])
          .map(id => ({ id, object: 'model', created: 0, owned_by: upstream.name })),
      })
      return
    }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      json(res, 200, { input_tokens: estimateInputTokens(await readBody(req)) })
      return
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      await handleMessages(req, res, await readBody(req))
      return
    }
    anthropicError(res, 404, `no route for ${req.method} ${path}`, 'not_found_error')
  }

  const server = http.createServer((req, res) => {
    // 长连接不设超时：一轮对话可能安静地想很久，由 ping 帧维持。
    res.setTimeout?.(0)
    handle(req, res).catch(error => {
      const status = Number(error?.statusCode) || 500
      log(`error ${req.method} ${req.url}: ${error?.message ?? error}`)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      anthropicError(res, status, String(error?.message ?? error))
    })
  })

  return {
    server,
    /** 默认只监听回环：这个口子花的是本机账号的额度。 */
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => resolve(server.address()))
    }),
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
    warm: () => refreshModels(),
  }
}
