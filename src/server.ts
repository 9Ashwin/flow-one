// Local reverse proxy: Anthropic Messages on the inbound side, an OpenAI
// chunk stream on the outbound side.
//
// Routes:
// - `POST /v1/messages` (including `/messages` and `?beta=true`), streaming and non-streaming
// - `POST /v1/messages/count_tokens`, estimated locally
// - `GET  /v1/models`, the upstream catalogue with product prefixes
// - `GET  /health`
//
// Deliberate behaviours:
// - **The upstream answers before any response header is written.** An upstream
//   401/429/400 therefore reaches Claude Code as its real status code instead of
//   a 200 followed by an apology inside the stream. Once headers are out, a
//   failure can only surface as an in-stream `error` event. Uncertain network
//   failures are not retried because the upstream may already have billed the turn.
// - **`message_start` is emitted on connect.** A reasoning model can think for
//   seventy seconds without emitting a byte, while the Anthropic contract starts
//   the message at handshake time; waiting for the first chunk leaves the client
//   stuck on "connecting".
// - **`ping` frames while quiet, an idle watchdog for the other direction.**
//   Heartbeats let the client distinguish "still thinking" from "disconnected";
//   the watchdog covers an upstream that stays connected but never produces,
//   which must not hold the turn open indefinitely.
// - **Backpressure on the write side.** A client that reads slower than the
//   upstream produces suspends the upstream pull loop; without that, memory grows
//   with the response while the upstream keeps billing.
// - **Model-name fallback.** Claude Code sends Claude model names while the
//   upstream expects IDs such as `cn/deepseek-v4.1-flash`; an unmapped name falls
//   back to the default model so the session stays usable.
// - **Every turn leaves a line, including the failed ones.** The log used to record
//   only completed turns, so a user reporting "it keeps erroring" had no server-side
//   counterpart to point at; failures now carry the status, the source and the
//   underlying cause.

import http from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { validateListenAuth } from './config.ts'
import crypto from 'node:crypto'
import {
  anthropicMessage,
  createOutcome,
  createStreamTranslator,
  errorBody,
  estimateInputTokens,
  foldChunk,
  toOpenAiRequest,
} from './anthropic.ts'
import { systemRewriterFor } from './fingerprint.ts'
import type { BridgeConfig, ChatChunks, ChatResult, OpenAiRequestBody, Upstream, UpstreamModel } from './types.ts'

const MAX_BODY_BYTES = 32 * 1024 * 1024
const MODEL_TTL_MS = 60_000

/** A decoded JSON object from the request body; anything else narrows to undefined. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** `catch (error)` gives `unknown`; this reads a message without assuming the shape. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error)

/**
 * `fetch` reports every transport failure as the bare message "fetch failed" and hides the
 * real one (ECONNRESET, ENOTFOUND, TLS) in `cause`. Dropping it leaves a failed turn that
 * says nothing, which is exactly what made "sometimes it just errors" undiagnosable.
 */
const causeOf = (error: unknown): string => {
  const parts: string[] = []
  let current = (error as { cause?: unknown } | null)?.cause
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    const record = current as { code?: unknown; errno?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? record.code : typeof record.errno === 'string' ? record.errno : ''
    const message = messageOf(current)
    parts.push(code === '' ? message : `${code}${message === '' ? '' : ` ${message}`}`)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' <- ')
}

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  529: 'overloaded_error',
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

/**
 * Resolve once `res` has flushed its buffer.
 *
 * `res.write()` returning false means the socket buffer is full; continuing to
 * pull from the upstream would grow that buffer without bound while the
 * upstream keeps billing tokens. Awaiting `drain` suspends the upstream pull
 * loop instead, which is the only place backpressure can be applied.
 */
function drained(res: ServerResponse): Promise<void> {
  return new Promise<void>(resolve => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    // A client that goes away never drains; without this the pull loop would hang.
    res.once('close', done)
  })
}

/** Write that honours backpressure; resolves false when the client has gone away. */
async function writeFrame(res: ServerResponse, frame: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false
  if (res.writableNeedDrain) {
    await drained(res)
    if (res.writableEnded || res.destroyed) return false
  }
  if (res.write(frame)) return true
  await drained(res)
  return !res.writableEnded && !res.destroyed
}

/** Sentinel yielded by {@link untilAborted} when the signal fires. */
const ABORTED = Symbol('aborted')

/**
 * Pull loop that stops the moment `signal` aborts.
 *
 * A plain `for await` only ends when the upstream decides to reject — and an
 * upstream stuck on a half-open socket may never decide. Racing the iterator
 * against the signal is what lets the idle watchdog and client disconnects
 * actually end the turn. Closing the iterator stays best-effort: if the
 * upstream ignores abort, `return()` never settles, so it is not awaited.
 */
async function* untilAborted(chunks: ChatChunks, signal: AbortSignal): AsyncGenerator<unknown, void, undefined> {
  const iterator = chunks[Symbol.asyncIterator]()
  let aborted = signal.aborted
  let completed = false
  let fire: (value: typeof ABORTED) => void = () => {}
  const fired = new Promise<typeof ABORTED>(resolve => {
    fire = resolve
  })
  const stop = () => {
    aborted = true
    fire(ABORTED)
  }
  if (!aborted) signal.addEventListener('abort', stop, { once: true })
  try {
    while (!aborted) {
      const next = await Promise.race([iterator.next(), fired])
      if (next === ABORTED) break
      if (next.done === true) {
        completed = true
        return
      }
      yield next.value
    }
    // Abandoned mid-flight: release the upstream connection, but never await it —
    // an upstream that ignores abort would otherwise keep the turn alive.
  } finally {
    signal.removeEventListener('abort', stop)
    if (!completed) {
      const closing = Promise.resolve(iterator.return?.()).catch(() => {})
      if (!aborted) await closing
    }
  }
}

/**
 * Short correlation id for one request.
 *
 * Logs previously carried only `model=… ms=…`, which cannot tie a user-reported turn
 * back to the line that produced it. The id is echoed in the error envelope
 * (`request_id`) so a client-side complaint and a server-side log line meet.
 */
function requestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`
}

/**
 * Describe a failure across every attempt made for this request.
 *
 * A single mounted source needs no decoration: its message already says what
 * happened. With several, the interesting fact is *which* line failed, so the earlier
 * attempts are listed before the final error.
 */
function failureSummary(result: Extract<ChatResult, { ok: false }>): string {
  const attempts = result.attempts ?? []
  if (attempts.length === 0) return result.message
  // The upstream's own name is the *aggregate* ("direct", "gateway"); the interesting
  // fact is the source inside it, which `attempts` already carries. Appending the bare
  // message as well would just repeat the last entry.
  return attempts
    .map(item => `${item.upstream}${item.status === undefined ? '' : ` ${item.status}`}: ${item.message}`)
    .join('; ')
}

function anthropicError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string = ERROR_TYPES[status] ?? 'api_error',
  requestId?: string,
  retryAfter?: string,
): void {
  json(res, status, errorBody(type, message, requestId), retryAfter === undefined ? {} : { 'retry-after': retryAfter })
}

/** Constant-length comparison, so the response cannot leak how many key bytes matched. */
function keyMatches(provided: unknown, expected: string | undefined): boolean {
  if (typeof expected !== 'string' || expected === '') return true
  const a = Buffer.from(String(provided ?? ''), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function providedKey(req: IncomingMessage): string {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body exceeds 32 MiB'), { statusCode: 413 })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 })
  }
}

/** What the caller gets back: the raw server plus the two lifecycle calls. */
export interface BridgeServer {
  server: Server
  /** Loopback by default: whatever comes through here spends the machine owner's quota. */
  listen(): Promise<AddressInfo>
  close(): Promise<void>
  warm(): Promise<void>
}

export function createBridgeServer({
  config,
  upstream,
  log = () => {},
}: {
  config: BridgeConfig
  upstream: Upstream
  log?: (message: string) => void
}): BridgeServer {
  validateListenAuth(config)
  /** Model id → upstream metadata (image support, window, …). */
  const prefixSecret = crypto.randomBytes(32)
  const known = new Map<string, UpstreamModel>()
  let modelsFetchedAt = 0
  let refreshing: Promise<void> | undefined

  async function refreshModels(): Promise<void> {
    if (refreshing !== undefined) return refreshing
    refreshing = upstream
      .loadModels()
      .then(rows => {
        known.clear()
        for (const row of rows) if (typeof row?.id === 'string' && row.id !== '') known.set(row.id, row)
        modelsFetchedAt = Date.now()
      })
      .catch((error: unknown) => {
        log(`failed to load the model catalogue: ${messageOf(error)}`)
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  /**
   * Pass the ID through when the upstream knows it; otherwise fall back to the
   * default model. Claude model names always take the fallback path.
   */
  async function resolveModel(requested: unknown, needsImageMetadata: boolean): Promise<string> {
    // Claude Code's `[1m]` suffix is supposed to be stripped before the request is
    // sent (2.1.301 does strip it), but treating it as part of the upstream model
    // name only costs a wasted fallback lookup, so it is removed here.
    const raw = typeof requested === 'string' ? requested.trim().replace(/\[[^\]]*\]$/, '') : ''
    const wanted = raw
    if (wanted !== '' && Object.hasOwn(config.modelMap, wanted)) return config.modelMap[wanted]
    if (wanted !== '' && known.has(wanted)) {
      if (Date.now() - modelsFetchedAt > MODEL_TTL_MS) void refreshModels().catch(() => {})
      return wanted
    }
    const isDefault = wanted === '' || wanted === 'auto' || wanted === config.model || /^claude-/i.test(wanted)
    // Tencent's model metadata also controls reasoning and output limits, even for text.
    const needsMetadata = needsImageMetadata || /^(cn|intl)\//.test(config.model)
    if (config.model !== '' && isDefault && (!needsMetadata || known.has(config.model))) {
      if (Date.now() - modelsFetchedAt > MODEL_TTL_MS || known.size === 0) void refreshModels().catch(() => {})
      return config.model
    }
    if (Date.now() - modelsFetchedAt > MODEL_TTL_MS || known.size === 0) await refreshModels()
    if (wanted !== '' && known.has(wanted)) return wanted
    if (config.model !== '') return config.model
    // In direct mode the default model comes from the post-login catalogue; take the
    // first entry, which is the domestic product first.
    const first = known.keys().next().value
    if (first !== undefined) return first
    throw Object.assign(
      new Error('the upstream has no usable models: run login first, or pass a model ID with --model'),
      { statusCode: 400 },
    )
  }

  /**
   * Whether the resolved model can read images.
   *
   * Unknown metadata means "assume yes": degrading a model that does support
   * images silently loses information, while a rejected image is a visible 400.
   */
  const supportsImagesFor = (model: string): boolean => known.get(model)?.supportsImages !== false

  /** A missing response does not prove the upstream did not start or bill the turn. */
  async function openUpstream(body: OpenAiRequestBody, { signal }: { signal: AbortSignal }): Promise<ChatResult> {
    let result: ChatResult
    try {
      result = await upstream.chat(body, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      const status = (error as { statusCode?: unknown } | null)?.statusCode
      const cause = causeOf(error)
      return {
        ok: false,
        status: typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
        message: cause === '' ? messageOf(error) : `${messageOf(error)} (${cause})`,
      }
    }
    if (result.ok === true) return result
    const status = Number(result.status) || 502
    return { ...result, status }
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const started = Date.now()
    const reqId = requestId()
    // The first parsed chunk can be metadata; visible output is measured separately.
    let firstByteAt: number | undefined
    let firstOutputAt: number | undefined
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    if (res.destroyed) return
    const inputTokens = estimateInputTokens(body)
    const containsImage = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsImage)
      if (!isObject(value)) return false
      return (
        value.type === 'image' ||
        (value.type === 'tool_result' && containsImage(value.content)) ||
        (Object.hasOwn(value, 'role') && containsImage(value.content))
      )
    }
    const hasImages = isObject(body) && containsImage(body.messages)
    const requestedModel = await resolveModel(isObject(body) ? body.model : undefined, hasImages)
    if (controller.signal.aborted) return
    const model = requestedModel
    if (hasImages && (known.size === 0 || Date.now() - modelsFetchedAt > MODEL_TTL_MS)) await refreshModels()
    if (controller.signal.aborted) return
    if (hasImages && !supportsImagesFor(model)) {
      anthropicError(res, 400, 'model does not support image input', undefined, reqId)
      return
    }
    const wantsStream = isObject(body) ? body.stream === true : false
    const id = `msg_${crypto.randomBytes(12).toString('hex')}`

    const openWithTimeout = async (requestBody: OpenAiRequestBody): Promise<ChatResult> => {
      const idleMs = config.upstreamIdleMs ?? 0
      if (!(idleMs > 0)) return openUpstream(requestBody, { signal: controller.signal })
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          openUpstream(requestBody, { signal: controller.signal }),
          new Promise<ChatResult>(resolve => {
            timer = setTimeout(() => {
              resolve({ ok: false, status: 504, message: 'upstream did not respond before timeout' })
              controller.abort()
            }, idleMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const translated = toOpenAiRequest(body, {
      model,
      maxTokensCap: config.maxTokensCap,
      supportsImages: supportsImagesFor(model),
      rewriteSystem: systemRewriterFor(model, config.fingerprintRewrite),
    })
    if (translated.error !== undefined) {
      anthropicError(res, 400, translated.error, undefined, reqId)
      log(`${reqId} model=${model} failed status=400 ms=${Date.now() - started} ${translated.error}`)
      return
    }
    if (config.upstreamUsage === false) delete translated.body.stream_options
    const result = await openWithTimeout(translated.body)
    if (!result.ok) {
      const status = result.status ?? 502
      anthropicError(res, status, failureSummary(result), undefined, reqId, result.retryAfter)
      // A failed turn used to leave no trace at all: the log only ever recorded completed
      // ones, so "it errors sometimes" could not be tied to a source, a status or a time.
      log(`${reqId} model=${model} failed status=${status} ms=${Date.now() - started} ${failureSummary(result)}`)
      return
    }
    const prefixId = crypto
      .createHmac('sha256', prefixSecret)
      .update(
        JSON.stringify({
          model,
          system: translated.body!.messages?.filter(message => message.role === 'system'),
          tools: translated.body!.tools,
        }),
      )
      .digest('hex')
      .slice(0, 16)
    const cacheLog = (
      usage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
      upstreamInput: unknown,
    ): string => {
      const read = usage.cache_read_input_tokens
      if (read === undefined) return `prefix_id=${prefixId} cache_read=unknown cache_ratio=unknown`
      const total =
        typeof upstreamInput === 'number' && Number.isFinite(upstreamInput) && upstreamInput > 0
          ? upstreamInput
          : undefined
      return `prefix_id=${prefixId} in=${usage.input_tokens} cache_read=${read} cache_write=${usage.cache_creation_input_tokens ?? 'unknown'} cache_ratio=${total === undefined ? 'unknown' : (read / total).toFixed(4)}`
    }

    if (!wantsStream) {
      const outcome = createOutcome()
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      const arm = (): void => {
        clearTimeout(timer)
        const idleMs = config.upstreamIdleMs ?? 0
        if (idleMs > 0)
          timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, idleMs)
      }
      try {
        arm()
        for await (const chunk of untilAborted(result.chunks, controller.signal)) {
          firstByteAt ??= Date.now()
          arm()
          foldChunk(outcome, chunk)
          if (outcome.text !== '' || outcome.toolCalls.length > 0 || (config.showThinking && outcome.thinking !== ''))
            firstOutputAt ??= Date.now()
          if (outcome.error !== undefined) break
        }
      } catch (error) {
        if (!controller.signal.aborted) outcome.error = messageOf(error)
      } finally {
        clearTimeout(timer)
      }
      if (timedOut) {
        anthropicError(res, 504, 'upstream produced no output before timeout', undefined, reqId)
        return
      }
      if (controller.signal.aborted) return
      if (outcome.error !== undefined) {
        anthropicError(res, 502, outcome.error, undefined, reqId)
        return
      }
      let message
      try {
        message = anthropicMessage(outcome, {
          model,
          id,
          inputTokens,
          showThinking: config.showThinking,
        })
      } catch (error) {
        anthropicError(res, 502, messageOf(error), undefined, reqId)
        return
      }
      json(res, 200, message)
      log(
        `${reqId} model=${model} stream=0 ms=${Date.now() - started} first_chunk_ms=${firstByteAt === undefined ? '-' : firstByteAt - started} ttft=${firstOutputAt === undefined ? '-' : firstOutputAt - started} out=${outcome.text.length} ${cacheLog(message.usage, isObject(outcome.usage) && typeof outcome.usage.prompt_tokens === 'number' ? message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0) : undefined)}`,
      )
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let heartbeat: NodeJS.Timeout | undefined
    if (config.heartbeatMs !== undefined && config.heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed && !res.writableNeedDrain)
          res.write('event: ping\ndata: {"type":"ping"}\n\n')
      }, config.heartbeatMs)
      heartbeat.unref?.()
    }

    // Frames are buffered per upstream chunk and flushed outside the translator:
    // `write` must stay synchronous (frame order is the contract), and the flush
    // is where backpressure is awaited.
    let pending: string[] = []
    const translator = createStreamTranslator({
      model,
      id,
      inputTokens,
      showThinking: config.showThinking,
      write: (frame: string) => {
        if (
          frame.includes('"type":"text_delta"') ||
          frame.includes('"type":"input_json_delta"') ||
          frame.includes('"type":"thinking_delta"')
        )
          firstOutputAt ??= Date.now()
        pending.push(frame)
      },
    })
    const flush = async (): Promise<boolean> => {
      const frames = pending
      pending = []
      for (const frame of frames) if (!(await writeFrame(res, frame))) return false
      return true
    }

    // A silent upstream must not hold the turn open forever. `idleMs` restarts on
    // every chunk (reasoning models are quiet, not dead); 0 disables the watchdog.
    let idleTimer: NodeJS.Timeout | undefined
    let idleFired = false
    const armIdle = (): void => {
      clearTimeout(idleTimer)
      const idleMs = config.upstreamIdleMs ?? 0
      if (!(idleMs > 0)) return
      idleTimer = setTimeout(() => {
        idleFired = true
        controller.abort()
      }, idleMs)
      idleTimer.unref?.()
    }

    try {
      // The handshake goes out now, not after the first upstream byte.
      translator.begin()
      if (!(await flush())) return
      armIdle()
      for await (const chunk of untilAborted(result.chunks, controller.signal)) {
        firstByteAt ??= Date.now()
        clearTimeout(idleTimer)
        if (!translator.push(chunk)) break
        if (!(await flush())) return
        armIdle()
      }
      // `untilAborted` ends the loop silently when the signal fires, so an aborted
      // pull must be classified here rather than in the catch branch. A client that
      // simply went away needs no error frame; a watchdog trip does.
      if (translator.failure !== undefined) translator.fail(translator.failure)
      else if (idleFired)
        translator.fail(
          `upstream produced no output for ${Math.round((config.upstreamIdleMs ?? 0) / 1000)} seconds, aborted`,
        )
      else if (controller.signal.aborted) translator.fail('client disconnected')
      else translator.end()
      await flush()
    } catch (error) {
      // Response headers are already out; the in-stream error event is the only
      // remaining way to report the failure.
      translator.fail(messageOf(error))
      await flush()
    } finally {
      clearTimeout(idleTimer)
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
      const usage = translator.usage
      // A turn that ended with an in-stream error used to log exactly like a finished
      // one (`out=0`), so a client-side complaint had no counterpart here. The reason
      // is appended after the metrics so the existing log format still parses.
      const failure = translator.failure
      log(
        `${reqId} model=${model} stream=1 ms=${Date.now() - started} first_chunk_ms=${firstByteAt === undefined ? '-' : firstByteAt - started} ttft=${firstOutputAt === undefined ? '-' : firstOutputAt - started}` +
          ` out=${usage.output_tokens} ${cacheLog(usage, translator.upstreamInputTokens)}` +
          (failure === undefined ? '' : ` failed=${failure}`),
      )
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'

    if (path === '/health') {
      json(res, 200, {
        ok: true,
        service: 'flow-one',
        upstream: upstream.describe(),
        models: known.size,
        model: config.model,
      })
      return
    }
    if (!keyMatches(providedKey(req), config.apiKey)) {
      anthropicError(res, 401, 'missing or invalid API key', 'authentication_error')
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (Date.now() - modelsFetchedAt > MODEL_TTL_MS || known.size === 0) await refreshModels()
      const ids = [...known.keys()]
      json(res, 200, {
        object: 'list',
        data: (ids.length > 0 ? ids : config.model === '' ? [] : [config.model]).map(id => ({
          id,
          object: 'model',
          created: 0,
          owned_by: upstream.name,
        })),
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
    // No socket timeout: a turn may legitimately think for a long time, and the
    // ping frames keep intermediaries from treating the idle stream as dead.
    // Silence is bounded by `upstreamIdleMs` on the upstream side instead —
    // a client that stops reading is bounded by backpressure in `writeFrame`.
    res.setTimeout?.(0)
    handle(req, res).catch((error: unknown) => {
      const status = Number((error as { statusCode?: unknown } | null)?.statusCode) || 500
      log(`error ${req.method} ${req.url}: ${messageOf(error)}`)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      anthropicError(res, status, String((error as { message?: unknown } | null)?.message ?? error))
    })
  })

  return {
    server,
    /** Loopback by default: whatever comes through here spends the machine owner's quota. */
    listen: (): Promise<AddressInfo> =>
      new Promise<AddressInfo>((resolve, reject) => {
        validateListenAuth(config)
        server.once('error', reject)
        server.listen(config.port, config.host, () => resolve(server.address() as AddressInfo))
      }),
    close: (): Promise<void> =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
    warm: (): Promise<void> => refreshModels(),
  }
}
