/**
 * Anthropic Messages ⇄ OpenAI Chat Completions 的纯翻译层。
 *
 * 这里只做数据变换：请求体进、请求体出；OpenAI 分片进、Anthropic SSE 帧出。
 * 没有 socket、没有定时器、没有文件系统——所以它可以脱离服务器被直接测。
 *
 * 请求侧映射：
 *
 * | Anthropic | OpenAI |
 * | --- | --- |
 * | `system`（字符串或块数组） | 首条 `{role:'system'}` 消息 |
 * | `text` 块 | `{type:'text'}` 部分（或裸字符串） |
 * | `image` 块（base64 / url） | `{type:'image_url'}` 部分 |
 * | `tool_use` 块 | 助手消息上的 `tool_calls[]` |
 * | `tool_result` 块 | `{role:'tool', tool_call_id}` 独立消息 |
 * | `tools[].input_schema` | `tools[].function.parameters` |
 * | `thinking.budget_tokens` | `reasoning_effort` |
 * | `stop_sequences` | `stop` |
 *
 * 响应侧的 `stop_reason`：只要本轮出现过工具调用就是 `tool_use`，否则
 * `length` → `max_tokens`，其余 → `end_turn`；错误走流内 `error` 事件。
 *
 * @module src/anthropic.mjs
 */

const IMAGE_TOKENS = 1024
const CHARS_PER_TOKEN = 4
const BASE_TOKENS = 16

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Anthropic 的块数组与裸字符串都要能读。 */
function blocksOf(content) {
  if (Array.isArray(content)) return content.filter(isObject)
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return []
}

function textOf(content) {
  return blocksOf(content)
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

/** `system` 在 Anthropic 里是一等公民，OpenAI 里只是第一条消息。 */
export function flattenSystem(system) {
  if (typeof system === 'string') return system.trim()
  return blocksOf(system)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/** 图片块 → OpenAI 的 `image_url`；无法识别的图片块返回 undefined（丢弃而非报错）。 */
function imagePart(block) {
  const source = block.source
  if (!isObject(source)) return undefined
  if (source.type === 'base64' && typeof source.data === 'string' && source.data !== '') {
    const mediaType = typeof source.media_type === 'string' && source.media_type !== '' ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return undefined
}

/** 块数组 → OpenAI 的 content 部分；全是文本时收敛成裸字符串，兼容性最好。 */
function contentParts(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const part = imagePart(block)
      if (part !== undefined) parts.push(part)
    }
  }
  if (parts.length === 0) return ''
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('')
  return parts
}

/** 工具结果的内容同样可能是块数组，且可以带图片。 */
function toolResultContent(content) {
  if (typeof content === 'string') return content
  const parts = contentParts(blocksOf(content))
  return parts
}

function toolCallsOf(blocks) {
  const calls = []
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    if (typeof block.name !== 'string' || block.name === '') continue
    calls.push({
      id: typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${calls.length}`,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    })
  }
  return calls
}

/**
 * `thinking.budget_tokens` → `reasoning_effort`。
 *
 * 上游（例如 dsh-our-free-model 的渠道网关）会把档位就近归一化到模型真正声明
 * 的那一档，所以这里给大中小三档就够，不必先知道模型支持什么。
 *
 * 边界取的是常见客户端「档位 → 预算表」相邻两档的中点（2026-10-22 对齐实测）：
 * DSH 的 pi-ai 适配器发的是 minimal 1024 / low 2048 / medium 8192 / high 16384
 * （xhigh 与 max 由它自己 clamp 成 high，Anthropic 协议只有预算、没有扩展档）。
 * 之前写成 `≥8192 → high`、`≥2048 → medium`，结果 DSH 选 low 得到 medium、
 * 选 medium 得到 high —— 整体升一档。中点边界让 low/medium/high 一一对应，
 * 也仍然覆盖 Claude Code 那种 4096/8192/16384 的预算。
 */
function effortFor(thinking) {
  if (!isObject(thinking) || thinking.type !== 'enabled') return undefined
  const budget = Number(thinking.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return undefined
  if (budget >= 12288) return 'high' // mid(8192, 16384)
  if (budget >= 4096) return 'medium' // mid(2048, 8192)
  return 'low'
}

function toolChoiceFor(choice, hasTools) {
  if (!isObject(choice)) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name !== '') {
    return { type: 'function', function: { name: choice.name } }
  }
  // 上游只认字符串 tool_choice；目录式 `{type:'tool'}` 无名字时退回自动。
  return hasTools ? 'auto' : undefined
}

/**
 * Anthropic 请求体 → OpenAI 请求体。
 *
 * @returns {{body: object}|{error: string}} 校验失败时给 `error`，由服务端翻成 400。
 */
export function toOpenAiRequest(request, { model, maxTokensCap = 0, rewriteSystem } = {}) {
  if (!isObject(request)) return { error: 'the request body must be a JSON object' }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: '`messages` must be a non-empty array' }
  }

  const messages = []
  const raw = flattenSystem(request.system)
  const system = raw !== '' && typeof rewriteSystem === 'function' ? rewriteSystem(raw) : raw
  if (system !== '') messages.push({ role: 'system', content: system })

  for (const row of request.messages) {
    if (!isObject(row)) continue
    const blocks = blocksOf(row.content)

    if (row.role === 'assistant') {
      const text = textOf(blocks)
      const toolCalls = toolCallsOf(blocks)
      if (text === '' && toolCalls.length === 0) continue
      const message = { role: 'assistant', content: text }
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      messages.push(message)
      continue
    }

    // 其余角色（user、缺省）都是用户侧。工具结果必须先落地：OpenAI 要求
    // `role:'tool'` 紧跟在那条带 tool_calls 的助手消息之后，而同一轮里的文本
    // 排在后面不影响语义。
    const pending = []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (callId === '') continue
        messages.push({ role: 'tool', tool_call_id: callId, content: toolResultContent(block.content) })
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') pending.push(block)
      else if (block.type === 'image') pending.push(block)
    }
    if (pending.length > 0) {
      const content = contentParts(pending)
      if (content !== '' && !(Array.isArray(content) && content.length === 0)) messages.push({ role: 'user', content })
    }
  }

  const rawTools = Array.isArray(request.tools) ? request.tools : []
  const tools = rawTools
    .filter(tool => isObject(tool) && typeof tool.name === 'string' && tool.name !== '')
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        ...typeof tool.description === 'string' && tool.description !== '' ? { description: tool.description } : {},
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
      },
    }))

  // 上游把「tool_choice: none 且带 tools」判为不可表达并直接 400，这里就地拆掉。
  const choice = toolChoiceFor(request.tool_choice, tools.length > 0)
  const dropTools = choice === 'none'

  const body = { model, messages }
  if (tools.length > 0 && !dropTools) body.tools = tools
  if (choice !== undefined) body.tool_choice = choice
  if (request.stream === true) body.stream = true

  const maxTokens = Number(request.max_tokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = maxTokensCap > 0 ? Math.min(Math.trunc(maxTokens), maxTokensCap) : Math.trunc(maxTokens)
  }
  const temperature = Number(request.temperature)
  if (Number.isFinite(temperature)) body.temperature = temperature
  const topP = Number(request.top_p)
  if (Number.isFinite(topP)) body.top_p = topP
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences.filter(item => typeof item === 'string')
  }
  const effort = effortFor(request.thinking)
  if (effort !== undefined) body.reasoning_effort = effort

  return { body }
}

/** 本地 token 估算：本桥不自带分词器，按 4 字符 ≈ 1 token，图片记固定值。 */
export function estimateInputTokens(request) {
  let chars = flattenSystem(request?.system).length
  let images = 0
  let frames = 0
  const walk = content => {
    for (const block of blocksOf(content)) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
      else if (block.type === 'image') images++
      else if (block.type === 'tool_result') { frames += 4; walk(block.content) }
      else if (block.type === 'tool_use') { frames += 4; chars += JSON.stringify(block.input ?? {}).length }
    }
  }
  for (const row of Array.isArray(request?.messages) ? request.messages : []) walk(row?.content)
  const toolChars = Array.isArray(request?.tools) ? JSON.stringify(request.tools).length : 0
  return Math.max(1, Math.round((chars + toolChars) / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + frames + BASE_TOKENS)
}

/** OpenAI 分片 → 累积结果。流式与非流式共用同一份归并逻辑。 */
export function createOutcome() {
  return { text: '', thinking: '', toolCalls: [], usage: undefined, finishReason: undefined, error: undefined }
}

export function foldChunk(outcome, chunk) {
  if (!isObject(chunk)) return
  if (isObject(chunk.usage)) outcome.usage = chunk.usage
  if (isObject(chunk.error)) {
    outcome.error = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
    return
  }
  for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
    if (!isObject(choice)) continue
    if (typeof choice.finish_reason === 'string') outcome.finishReason = choice.finish_reason
    const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : undefined
    if (delta === undefined) continue
    if (typeof delta.content === 'string') outcome.text += delta.content
    else if (Array.isArray(delta.content)) {
      for (const part of delta.content) if (isObject(part) && typeof part.text === 'string') outcome.text += part.text
    }
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : undefined
    if (reasoning !== undefined) outcome.thinking += reasoning
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isObject(call)) continue
      const index = Number.isInteger(call.index) ? call.index : outcome.toolCalls.findIndex(slot => slot.id === call.id)
      const at = index >= 0 ? index : outcome.toolCalls.length
      const slot = outcome.toolCalls[at] ??= { id: '', name: '', arguments: '' }
      if (typeof call.id === 'string' && call.id !== '') slot.id = call.id
      if (isObject(call.function)) {
        if (typeof call.function.name === 'string' && call.function.name !== '' && slot.name === '') slot.name = call.function.name
        if (typeof call.function.arguments === 'string') slot.arguments += call.function.arguments
      }
    }
  }
}

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' }

function stopReasonFor(outcome) {
  if (outcome.toolCalls.length > 0) return 'tool_use'
  return STOP_REASONS[outcome.finishReason] ?? 'end_turn'
}

/** 累积结果 → 非流式 Anthropic 消息体。思考块与流式一样只在显式开启时给出。 */
export function anthropicMessage(outcome, { model, id, inputTokens = 0, showThinking = false }) {
  const content = []
  if (showThinking && outcome.thinking !== '') content.push({ type: 'thinking', thinking: outcome.thinking })
  if (outcome.text !== '') content.push({ type: 'text', text: outcome.text })
  for (const call of outcome.toolCalls) {
    let input = {}
    try { input = call.arguments === '' ? {} : JSON.parse(call.arguments) } catch { input = {} }
    content.push({ type: 'tool_use', id: call.id || 'toolu_0', name: call.name, input })
  }
  const output = outcome.usage?.completion_tokens
  return {
    id, type: 'message', role: 'assistant', model,
    content,
    stop_reason: stopReasonFor(outcome),
    stop_sequence: null,
    usage: {
      input_tokens: outcome.usage?.prompt_tokens ?? inputTokens,
      output_tokens: typeof output === 'number' ? output : Math.round(outcome.text.length / CHARS_PER_TOKEN),
    },
  }
}

/**
 * 流式渲染器：把 OpenAI 的分片流写成 Anthropic 的具名事件流。
 *
 * `write` 收到的是完整的 SSE 帧字符串，调用方只管往 socket 上写——这让
 * 「成帧是否正确」可以在没有网络的情况下断言。
 */
export function createStreamTranslator({ model, id, write, showThinking = false, inputTokens = 0 }) {
  let nextIndex = 0
  let textIndex = null
  let thinkingIndex = null
  const toolSlots = new Map()
  const usage = { input_tokens: inputTokens, output_tokens: 0 }
  let stopReason = null
  let started = false
  let finished = false
  let error = undefined

  const send = (event, payload) => write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)

  function start() {
    if (started) return
    started = true
    send('message_start', {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  }

  function closeThinking() {
    if (thinkingIndex === null) return
    send('content_block_stop', { type: 'content_block_stop', index: thinkingIndex })
    thinkingIndex = null
  }

  function closeText() {
    if (textIndex === null) return
    send('content_block_stop', { type: 'content_block_stop', index: textIndex })
    textIndex = null
  }

  function closeTools() {
    for (const slot of [...toolSlots.values()].sort((a, b) => a.block - b.block)) {
      if (!slot.open) continue
      send('content_block_stop', { type: 'content_block_stop', index: slot.block })
      slot.open = false
    }
  }

  /** 思考块与文本块互斥：Anthropic 的块顺序就是产生顺序。 */
  function thinkingDelta(text) {
    if (!showThinking || text === '') return
    closeText()
    if (thinkingIndex === null) {
      thinkingIndex = nextIndex++
      send('content_block_start', { type: 'content_block_start', index: thinkingIndex, content_block: { type: 'thinking', thinking: '' } })
    }
    send('content_block_delta', { type: 'content_block_delta', index: thinkingIndex, delta: { type: 'thinking_delta', thinking: text } })
  }

  function textDelta(text) {
    if (text === '') return
    closeThinking()
    if (textIndex === null) {
      textIndex = nextIndex++
      send('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } })
    }
    send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } })
  }

  /**
   * 工具块必须带着名字开场，所以名字没到之前先把参数攒着——有的上游会把
   * `arguments` 先于 `name` 发出来，直接开场会得到一个 Claude Code 无法回传的
   * 匿名工具调用。
   */
  function openTool(slot) {
    if (slot.open || slot.name === '') return
    slot.open = true
    slot.block = nextIndex++
    send('content_block_start', {
      type: 'content_block_start', index: slot.block,
      content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
    })
    if (slot.buffer !== '') {
      send('content_block_delta', { type: 'content_block_delta', index: slot.block, delta: { type: 'input_json_delta', partial_json: slot.buffer } })
      slot.buffer = ''
    }
  }

  function toolDelta(call) {
    closeThinking()
    closeText()
    const key = Number.isInteger(call.index) ? call.index : toolSlots.size
    let slot = toolSlots.get(key)
    if (slot === undefined) {
      slot = { block: -1, id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${key}`, name: '', open: false, buffer: '' }
      toolSlots.set(key, slot)
    } else if (typeof call.id === 'string' && call.id !== '') {
      slot.id = call.id
    }
    const fn = isObject(call.function) ? call.function : {}
    if (typeof fn.name === 'string' && fn.name !== '' && slot.name === '') slot.name = fn.name
    const args = typeof fn.arguments === 'string' ? fn.arguments : ''
    if (args !== '') {
      if (slot.open) send('content_block_delta', { type: 'content_block_delta', index: slot.block, delta: { type: 'input_json_delta', partial_json: args } })
      else slot.buffer += args
    }
    openTool(slot)
  }

  return {
    /** 消费一个 OpenAI 分片；返回 false 表示这一分片宣告了失败。 */
    push(chunk) {
      if (finished || !isObject(chunk)) return true
      if (isObject(chunk.error)) {
        error = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
        return false
      }
      if (isObject(chunk.usage)) {
        if (typeof chunk.usage.prompt_tokens === 'number') usage.input_tokens = chunk.usage.prompt_tokens
        if (typeof chunk.usage.completion_tokens === 'number') usage.output_tokens = chunk.usage.completion_tokens
      }
      start()
      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (!isObject(choice)) continue
        if (typeof choice.finish_reason === 'string') stopReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn'
        const delta = isObject(choice.delta) ? choice.delta : {}
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : ''
        thinkingDelta(reasoning)
        if (typeof delta.content === 'string') textDelta(delta.content)
        else if (Array.isArray(delta.content)) {
          for (const part of delta.content) if (isObject(part) && typeof part.text === 'string') textDelta(part.text)
        }
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (isObject(call)) toolDelta(call)
        }
      }
      return true
    },
    /** 正常收尾：补齐块结束、stop_reason 与 usage，再发 message_stop。 */
    end() {
      if (finished) return
      start()
      finished = true
      closeThinking()
      closeText()
      // 收尾时仍未开场的工具块：名字到齐了就补开场，序号按 OpenAI 的下标排。
      for (const slot of [...toolSlots.values()].sort((a, b) => a.block - b.block)) {
        if (slot.open || slot.buffer === '') continue
        if (slot.name === '') slot.name = 'unknown_tool'
        openTool(slot)
      }
      closeTools()
      const reason = toolSlots.size > 0 ? 'tool_use' : error !== undefined ? 'end_turn' : stopReason ?? 'end_turn'
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      })
      send('message_stop', { type: 'message_stop' })
    },
    /** 失败收尾：Anthropic 用流内 error 事件表达「响应头已经发出之后才失败」。 */
    fail(message) {
      if (finished) return
      start()
      finished = true
      send('error', { type: 'error', error: { type: 'api_error', message: String(message) } })
      send('message_stop', { type: 'message_stop' })
    },
    get failure() { return error },
    get usage() { return { ...usage } },
  }
}

/** Anthropic 的错误信封。 */
export function errorBody(type, message) {
  return { type: 'error', error: { type, message } }
}
