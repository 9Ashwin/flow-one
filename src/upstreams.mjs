/**
 * 上游适配：把「网关」和「自己登录的腾讯产品」收敛成同一个接口。
 *
 * ```js
 * upstream.listModels()            → [{ id, ... }]      模型清单（ID 已带产品前缀）
 * upstream.chat(body, { signal })  → { ok: true, chunks } | { ok: false, status, message }
 * ```
 *
 * `chat` 的 `chunks` 一律是 **OpenAI 分片**。两种上游的报文本来就同源
 * （腾讯的 `/v2/chat/completions` 就是 OpenAI 形状），Anthropic 那一侧的翻译层
 * 因此只认一种输入，不必知道上游是谁。
 *
 * @module src/upstreams.mjs
 */

import { chat as buddyChat, listModels as buddyListModels } from './buddy.mjs'
import { ensureCredential } from './auth.mjs'
import { sourceByName } from './sources.mjs'
import { failureOf, readSse } from './sse.mjs'
import { chat as opencodeChat, listModels as opencodeListModels } from './opencode.mjs'

const MODEL_TTL_MS = 60_000

function authHeaders(key) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...key === '' ? {} : { authorization: `Bearer ${key}` },
  }
}

// ── 网关模式 ────────────────────────────────────────────────────────────────

/** 任何 OpenAI 兼容端点：DSH 的渠道网关、Ollama、vLLM、官方 API…… */
export function createGatewayUpstream(config) {
  async function loadModels() {
    const response = await fetch(`${config.upstream}/v1/models`, {
      headers: authHeaders(config.upstreamKey), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`上游模型清单失败（HTTP ${response.status}）`)
    const payload = await response.json()
    return (Array.isArray(payload?.data) ? payload.data : [])
      .filter(row => typeof row?.id === 'string' && row.id !== '')
      .map(row => ({
        id: row.id,
        name: row.name ?? row.id,
        // dsh-our-free-model 的网关会在清单里带上这些；别家没有就留空。
        ...typeof row.context_window === 'number' ? { contextWindow: row.context_window } : {},
        ...typeof row.max_tokens === 'number' ? { maxOutputTokens: row.max_tokens } : {},
        ...Array.isArray(row.input) ? { supportsImages: row.input.includes('image') } : {},
        ...Array.isArray(row.reasoning?.openai_efforts) ? { efforts: row.reasoning.openai_efforts } : {},
      }))
  }

  return {
    name: 'gateway',
    describe: () => `网关 ${config.upstream}`,
    loadModels,
    async chat(body, { signal } = {}) {
      const response = await fetch(`${config.upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders(config.upstreamKey),
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      })
      if (!response.ok) return failureOf(response)
      return { ok: true, chunks: readSse(response.body) }
    },
  }
}

// ── 直连模式 ────────────────────────────────────────────────────────────────

/**
 * 自己登录的腾讯产品 + 无需登录的 OpenCode 免费档。
 *
 * 模型 ID 一律带来源前缀（`cn/…`、`intl/…`、`oc/…`），因此**一个进程能同时服务
 * 三条线**：Claude Code 换一个 `ANTHROPIC_MODEL` 就换了来源。
 */
export function createDirectUpstream(config, { log = () => {} } = {}) {
  const products = config.products
  const meta = new Map()
  let cached = []
  let cachedAt = 0
  let loading

  const productFor = id => {
    const raw = String(id)
    const at = raw.indexOf('/')
    if (at < 0) return { product: products[0], model: raw }
    // 先在本进程挂载的产品里找，再退回别名表：测试与自定义产品都用本机端点，
    // 直接拿别名表会解析成那两条内置产品常量，前缀也就剥不掉了。
    const named = products.find(item => item.id === raw.slice(0, at)) ?? sourceByName(raw.slice(0, at))
    if (named === undefined || !products.includes(named)) return { product: products[0], model: raw }
    return { product: named, model: raw.slice(at + 1) }
  }

  async function loadAll() {
    const rows = []
    for (const product of products) {
      try {
        // 免费档不需要凭据，形状对了就能用；腾讯两条线要先登录
        const models = product.kind === 'openai'
          ? await opencodeListModels(product)
          : await buddyListModels(product, await ensureCredential(product, { log, file: config.credentialFile }), { log })
        for (const model of models) {
          meta.set(`${product.id}/${model.id}`, model)
          // 前缀必须盖在展开之后：`...model` 里的裸 id 会把带前缀的 id 顶掉。
          rows.push({ ...model, id: `${product.id}/${model.id}`, name: model.name ?? model.id, product: product.id })
        }
      } catch (error) {
        log(`${product.label}：模型清单不可用 —— ${error.message}`)
      }
    }
    return rows
  }

  async function loadModels() {
    if (Date.now() - cachedAt < MODEL_TTL_MS && cached.length > 0) return cached
    if (loading !== undefined) return loading
    loading = loadAll().then(rows => {
      cached = rows
      cachedAt = Date.now()
      return rows
    }).finally(() => { loading = undefined })
    return loading
  }

  return {
    name: 'direct',
    describe: () => `直连 ${products.map(product => product.label).join(' + ')}`,
    loadModels,
    async chat(body, { signal } = {}) {
      const { product, model } = productFor(body.model)
      if (product.kind === 'openai') return await opencodeChat(product, model, body, { signal, log })
      const result = await buddyChat(product, { ...body, model: undefined }, {
        model,
        meta: meta.get(`${product.id}/${model}`),
        signal,
        log,
        file: config.credentialFile,
      })
      if (!result.ok) return result
      // 流内的策略拦截是「HTTP 200 + 一帧 {code,msg}」，没有 choices；
      // 有效内容帧一定带 choices，据此把它翻成统一的分片错误。
      const chunks = readSse(result.response.body)
      return { ok: true, chunks: rejectInStream(chunks, product) }
    },
  }
}

/** 把 `{code:11140,...}` 这类流内错误帧变成 `{error:{message}}`，交给翻译层统一收尾。 */
async function* rejectInStream(chunks, product) {
  for await (const chunk of chunks) {
    const hasChoices = Object.hasOwn(chunk ?? {}, 'choices')
    const code = chunk?.code
    if (!hasChoices && (typeof code === 'number' || typeof chunk?.msg === 'string')) {
      const message = chunk?.msg ?? chunk?.message ?? chunk?.displayMsg ?? `code ${code}`
      yield { error: { message: `${product.label}：${message}` } }
      return
    }
    yield chunk
  }
}
