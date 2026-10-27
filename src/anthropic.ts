// Pure translation layer between Anthropic Messages and OpenAI Chat Completions.
//
// Only data transformation happens here: request body in, request body out;
// OpenAI chunks in, Anthropic SSE frames out. No sockets, no timers, no
// filesystem — which is what makes it directly testable without a server.
//
// Request-side mapping:
//
// | Anthropic | OpenAI |
// | --- | --- |
// | `system` (string or block array) | leading `{role:'system'}` message |
// | `text` block | `{type:'text'}` part (or a bare string) |
// | `image` block (base64 / url) | `{type:'image_url'}` part |
// | `tool_use` block | `tool_calls[]` on the assistant message |
// | `tool_result` block | standalone `{role:'tool', tool_call_id}` message |
// | `tools[].input_schema` | `tools[].function.parameters` |
// | `thinking.budget_tokens` | `reasoning_effort` |
// | `stop_sequences` | `stop` |
//
// Response-side `stop_reason`: `tool_use` whenever the turn produced a tool
// call, otherwise `length` → `max_tokens`, `content_filter` → `refusal`, and
// everything else → `end_turn`; failures travel as in-stream `error` events.

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicUsage,
  ApiError,
  OpenAiContentPart,
  OpenAiMessage,
  OpenAiRequestBody,
  OpenAiTool,
  OpenAiToolCall,
  OpenAiToolChoice,
  Outcome,
  RequestTranslation,
  StreamTranslator,
  StreamTranslatorOptions,
  ToOpenAiRequestOptions,
} from './types.ts'

const IMAGE_TOKENS = 1024
const CHARS_PER_TOKEN = 4
const BASE_TOKENS = 16
/** Placeholder substituted for image blocks when the upstream model cannot read them. */
const IMAGE_PLACEHOLDER = '[image omitted: the selected model does not accept image input]'
/** Translated thinking blocks carry no upstream signature; clients require a non-empty base64 value. */
export const TRANSLATED_THINKING_SIGNATURE = 'AA=='

/** A decoded JSON object; everything else (null, arrays, primitives) stays out. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function toolInput(argumentsJson: string): Record<string, unknown> {
  let input: unknown
  try {
    input = argumentsJson === '' ? {} : JSON.parse(argumentsJson)
  } catch {
    throw new Error('upstream tool arguments are not valid JSON')
  }
  if (!isObject(input)) throw new Error('upstream tool arguments must be a JSON object')
  return input
}

/** Match a tool fragment by index or id, refusing ambiguous parallel fragments. */
export function resolveToolIndex(call: Record<string, unknown>, slots: Array<[number, { id: string }]>): number {
  if (Number.isInteger(call.index) && (call.index as number) >= 0) return call.index as number
  const id = typeof call.id === 'string' ? call.id : ''
  if (id !== '') {
    const match = slots.find(([, slot]) => slot.id === id)
    if (match !== undefined) return match[0]
    if (slots.length === 1 && slots[0][1].id === '') return slots[0][0]
    let index = 0
    while (slots.some(([key]) => key === index)) index++
    return index
  }
  if (slots.length === 0) return 0
  if (slots.length === 1) return slots[0][0]
  throw new Error('upstream tool fragment cannot be matched to a parallel call')
}

/** Accept both Anthropic's block array and its bare-string shorthand. */
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (Array.isArray(content)) return content.filter(isObject)
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return []
}

function textOf(content: unknown): string {
  return blocksOf(content)
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

/** `system` is a first-class field in Anthropic but merely the first message in OpenAI. */
export function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system
  return blocksOf(system)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

/** Image block → OpenAI `image_url`; an unrecognised source returns undefined (dropped, not an error). */
function imagePart(block: Record<string, unknown>): OpenAiContentPart | undefined {
  const source = block.source
  if (!isObject(source)) return undefined
  if (source.type === 'base64' && typeof source.data === 'string' && source.data !== '') {
    const mediaType =
      typeof source.media_type === 'string' && source.media_type !== '' ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return undefined
}

/**
 * Models without image input reject the whole request with a 400 when an
 * `image_url` part is present. Degrading the block to a text placeholder keeps
 * the turn usable and tells the model what it is missing.
 */
function contentParts(
  blocks: Record<string, unknown>[],
  { supportsImages = true }: { supportsImages?: boolean } = {},
): string | OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '')
      parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      if (!supportsImages) {
        parts.push({ type: 'text', text: IMAGE_PLACEHOLDER })
        continue
      }
      const part = imagePart(block)
      if (part !== undefined) parts.push(part)
    }
  }
  if (parts.length === 0) return ''
  if (parts.every(part => part.type === 'text'))
    return parts.map(part => (part.type === 'text' ? part.text : '')).join('')
  return parts
}

/** Tool results carry the same block shapes, images included. */
function toolResultContent(content: unknown, options: { supportsImages?: boolean }): string | OpenAiContentPart[] {
  if (typeof content === 'string') return content
  const parts = contentParts(blocksOf(content), options)
  return parts
}

function toolCallsOf(blocks: Record<string, unknown>[]): OpenAiToolCall[] {
  const calls: OpenAiToolCall[] = []
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
 * `thinking.budget_tokens` → `reasoning_effort`.
 *
 * The upstream (for example DSH's channel gateway) normalises the requested
 * level to whichever level the model actually declares, so three buckets —
 * small, medium, large — are enough here; the model's own capability list does
 * not have to be known in advance.
 *
 * The boundaries are the midpoints between adjacent rows of the
 * "level → budget" tables common clients use (measured 2026-10-22): DSH's
 * pi-ai adapter sends minimal 1024 / low 2048 / medium 8192 / high 16384
 * (`xhigh` and `max` are clamped by DSH itself to `high`; the Anthropic wire
 * has budgets but no extended levels). The previous mapping was
 * `>= 8192 → high`, `>= 2048 → medium`, so DSH's `low` arrived as `medium` and
 * `medium` as `high` — every level shifted up by one. Midpoint boundaries make
 * low/medium/high correspond one-to-one while still covering the
 * 4096/8192/16384 budgets Claude Code sends.
 */
function effortFor(thinking: unknown): string | undefined {
  if (!isObject(thinking) || thinking.type !== 'enabled') return undefined
  const budget = Number(thinking.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return undefined
  if (budget >= 12288) return 'high' // mid(8192, 16384)
  if (budget >= 4096) return 'medium' // mid(2048, 8192)
  return 'low'
}

function toolChoiceFor(choice: unknown, hasTools: boolean): OpenAiToolChoice | undefined {
  if (!isObject(choice)) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name !== '') {
    return { type: 'function', function: { name: choice.name } }
  }
  // The upstream only accepts the string form of `tool_choice`; a nameless
  // catalogue-style `{type:'tool'}` falls back to automatic.
  return hasTools ? 'auto' : undefined
}

/**
 * Anthropic request body → OpenAI request body.
 *
 * `stream: true` is always set: streaming and non-streaming share one upstream
 * path, with non-streaming folded back together by the server, so "non-streaming"
 * differs only in one fold branch. `stream_options.include_usage` rides along —
 * without it a plain OpenAI-wire upstream returns no usage at all on a streaming
 * response, leaving token counts and cache-hit reporting to the local estimate.
 *
 * @returns either `{body}` or, on validation failure, `{error}`, which the server
 *   turns into a 400.
 */
export function toOpenAiRequest(
  request: unknown,
  { model, maxTokensCap = 0, rewriteSystem, supportsImages = true }: ToOpenAiRequestOptions = {},
): RequestTranslation {
  if (!isObject(request)) return { error: 'the request body must be a JSON object' }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: '`messages` must be a non-empty array' }
  }
  const contentOptions = { supportsImages }

  const messages: OpenAiMessage[] = []
  const raw = flattenSystem(request.system)
  const system = raw !== '' && typeof rewriteSystem === 'function' ? rewriteSystem(raw) : raw
  if (system !== '') messages.push({ role: 'system', content: system })

  for (const row of request.messages) {
    if (!isObject(row) || (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system'))
      return { error: `unsupported message role: ${isObject(row) ? String(row.role) : 'invalid'}` }
    const blocks = blocksOf(row.content)
    if (row.role === 'system') {
      if (blocks.some(block => block.type !== 'text')) return { error: 'unsupported system content block' }
      const text = flattenSystem(row.content)
      if (text !== '')
        messages.push({ role: 'system', content: typeof rewriteSystem === 'function' ? rewriteSystem(text) : text })
      continue
    }
    const allowed =
      row.role === 'assistant'
        ? ['text', 'tool_use', 'thinking', 'redacted_thinking']
        : ['text', 'image', 'tool_result']
    for (const block of blocks) {
      if (typeof block.type !== 'string' || !allowed.includes(block.type))
        return { error: `unsupported content block: ${String(block.type)}` }
      if (block.type === 'image' && supportsImages && imagePart(block) === undefined)
        return { error: 'unsupported image source' }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const part of blocksOf(block.content)) {
          if (part.type !== 'text' && part.type !== 'image')
            return { error: `unsupported tool result content: ${String(part.type)}` }
          if (part.type === 'image' && supportsImages && imagePart(part) === undefined)
            return { error: 'unsupported image source' }
        }
      }
    }

    if (row.role === 'assistant') {
      const text = textOf(blocks)
      const toolCalls = toolCallsOf(blocks)
      if (text === '' && toolCalls.length === 0) continue
      const message: OpenAiMessage = { role: 'assistant', content: text }
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      messages.push(message)
      continue
    }

    // Every other role (user, or missing) is the user side. Tool results are emitted
    // first: OpenAI requires `role:'tool'` to follow immediately after the assistant
    // message carrying the `tool_calls`, while the text from the same turn is
    // order-insensitive.
    const pending = []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        if (pending.length > 0)
          return { error: 'text or images before a tool result cannot be represented without reordering' }
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (callId === '') continue
        messages.push({ role: 'tool', tool_call_id: callId, content: toolResultContent(block.content, contentOptions) })
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') pending.push(block)
      else if (block.type === 'image') pending.push(block)
    }
    if (pending.length > 0) {
      const content = contentParts(pending, contentOptions)
      if (content !== '' && !(Array.isArray(content) && content.length === 0)) messages.push({ role: 'user', content })
    }
  }

  const rawTools: unknown[] = Array.isArray(request.tools) ? request.tools : []
  const tools: OpenAiTool[] = rawTools
    .filter(
      (tool): tool is Record<string, unknown> => isObject(tool) && typeof tool.name === 'string' && tool.name !== '',
    )
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name as string,
        ...(typeof tool.description === 'string' && tool.description !== '' ? { description: tool.description } : {}),
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
      },
    }))

  // The upstream treats "tool_choice: none together with tools" as inexpressible and
  // rejects it with a 400, so the tools are dropped here instead.
  const choice = toolChoiceFor(request.tool_choice, tools.length > 0)
  const dropTools = choice === 'none'

  const body: OpenAiRequestBody = { model, messages }
  if (tools.length > 0 && !dropTools) body.tools = tools
  if (choice !== undefined) body.tool_choice = choice
  if (
    !dropTools &&
    tools.length > 0 &&
    isObject(request.tool_choice) &&
    request.tool_choice.disable_parallel_tool_use === true
  )
    body.parallel_tool_calls = false
  // Every upstream request streams, including when the Anthropic response is folded
  // into JSON. Request usage in both cases so cached tokens do not disappear.
  body.stream = true
  body.stream_options = { include_usage: true }

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
  const outputConfig = isObject(request.output_config) ? request.output_config : {}
  const effort =
    typeof outputConfig.effort === 'string'
      ? outputConfig.effort
      : (effortFor(request.thinking) ??
        (isObject(request.thinking) && request.thinking.type === 'adaptive' ? 'medium' : undefined))
  if (effort !== undefined) body.reasoning_effort = effort
  if (outputConfig.format !== undefined) {
    const format = outputConfig.format
    if (!isObject(format) || format.type !== 'json_schema' || !isObject(format.schema))
      return { error: 'unsupported output format' }
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'messages_response', strict: true, schema: format.schema },
    }
  }

  // Anthropic's fast mode selects the upstream's priority lane. Measured 2026-10-27
  // against `opencode.ai/zen/go/v1`: a request carrying `service_tier: "priority"`
  // returns 200 and streams normally, so forwarding it is safe. Whether the upstream
  // actually prioritises the turn is not observable from here — if it ever starts
  // rejecting the field, drop this mapping rather than dropping the whole request.
  if (request.speed === 'fast') body.service_tier = 'priority'

  return { body }
}

/**
 * Local token estimate. The bridge ships no tokeniser, so it assumes roughly
 * one token per four characters and charges a flat cost per image.
 */
export function estimateInputTokens(request: unknown): number {
  const source = isObject(request) ? request : {}
  let chars = flattenSystem(source.system).length
  let images = 0
  let frames = 0
  const walk = (content: unknown): void => {
    for (const block of blocksOf(content)) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
      else if (block.type === 'image') images++
      else if (block.type === 'tool_result') {
        frames += 4
        walk(block.content)
      } else if (block.type === 'tool_use') {
        frames += 4
        chars += JSON.stringify(block.input ?? {}).length
      }
    }
  }
  for (const row of Array.isArray(source.messages) ? source.messages : []) walk(isObject(row) ? row.content : undefined)
  const toolChars = Array.isArray(source.tools) ? JSON.stringify(source.tools).length : 0
  return Math.max(1, Math.round((chars + toolChars) / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + frames + BASE_TOKENS)
}

/**
 * OpenAI-shaped `usage` → Anthropic's pair of counters.
 *
 * The two conventions differ, and that difference decides whether cache hits are
 * visible to the client at all: OpenAI counts cache reads *inside*
 * `prompt_tokens`, while Anthropic lists `cache_read_input_tokens` and
 * `cache_creation_input_tokens` *alongside* `input_tokens`. Passing the upstream
 * numbers straight through makes Claude Code treat the whole prompt as fresh
 * input, so the cache always reads as zero.
 *
 * Field names vary by upstream; the first numeric candidate wins:
 *
 * | Meaning | Candidate fields |
 * | --- | --- |
 * | cache read | `prompt_tokens_details.cached_tokens` (OpenAI / vLLM / Gemini compat layer), `prompt_cache_hit_tokens` (DeepSeek), `cached_tokens` (Moonshot) |
 * | cache write | `prompt_tokens_details.cache_creation_input_tokens`, `prompt_tokens_details.cache_write_tokens` (OpenRouter) |
 *
 * An upstream that reports more cached tokens than `prompt_tokens` is not an
 * error: the counts are clamped, because one miscalibrated usage block should
 * not turn a whole turn into a 500.
 */
function anthropicUsageFrom(
  openAiUsage: unknown,
  fallback: { inputTokens?: number; outputTokens?: number } = {},
): AnthropicUsage {
  const usage = isObject(openAiUsage) ? openAiUsage : {}
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const pick = (...candidates: unknown[]): number | undefined => {
    for (const candidate of candidates)
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
    return undefined
  }
  const prompt = pick(usage.prompt_tokens)
  const cacheRead = pick(details.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens)
  const cacheWrite = pick(details.cache_creation_input_tokens, details.cache_write_tokens)
  const output = pick(usage.completion_tokens) ?? fallback.outputTokens
  const reasoning = pick(
    isObject(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens : undefined,
  )

  const result: AnthropicUsage = {
    input_tokens:
      prompt === undefined
        ? (fallback.inputTokens ?? 0)
        : prompt - Math.min(prompt, (cacheRead ?? 0) + (cacheWrite ?? 0)),
    output_tokens: output ?? 0,
  }
  // The cache fields are written only when the upstream reported them: Anthropic uses
  // `null` for "not applicable", and a literal 0 would read as "caching exists but
  // never hit".
  if (cacheRead !== undefined) result.cache_read_input_tokens = Math.min(cacheRead, prompt ?? cacheRead)
  if (cacheWrite !== undefined) {
    // Read and write are disjoint input buckets; together they cannot exceed the
    // upstream's total even if its counters are inconsistent.
    const remaining = prompt === undefined ? cacheWrite : Math.max(0, prompt - (result.cache_read_input_tokens ?? 0))
    result.cache_creation_input_tokens = Math.min(cacheWrite, remaining)
  }
  if (reasoning !== undefined) result.output_tokens_details = { thinking_tokens: reasoning }
  return result
}

/** OpenAI chunk → accumulated outcome. Streaming and non-streaming share this fold. */
export function createOutcome(): Outcome {
  return { text: '', thinking: '', toolCalls: [], usage: undefined, finishReason: undefined, error: undefined }
}

export function foldChunk(outcome: Outcome, chunk: unknown): void {
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
      for (const part of delta.content)
        if (isObject(part)) {
          if (typeof part.text === 'string') outcome.text += part.text
          else if (typeof part.refusal === 'string') outcome.text += part.refusal
        }
    }
    if (typeof delta.refusal === 'string') outcome.text += delta.refusal
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : undefined
    if (reasoning !== undefined) outcome.thinking += reasoning
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    if (calls.filter(call => isObject(call) && !Number.isInteger(call.index) && !call.id).length > 1) {
      outcome.error = 'upstream tool fragments cannot be matched to parallel calls'
      return
    }
    for (const call of calls) {
      if (!isObject(call)) continue
      let at: number
      try {
        at = resolveToolIndex(
          call,
          Object.entries(outcome.toolCalls).map(([index, slot]) => [Number(index), slot]),
        )
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error)
        return
      }
      const slot = (outcome.toolCalls[at] ??= { id: '', name: '', arguments: '' })
      if (typeof call.id === 'string' && call.id !== '' && slot.id !== '' && slot.id !== call.id) {
        outcome.error = 'upstream tool index changed identity'
        return
      }
      if (typeof call.id === 'string' && call.id !== '') slot.id = call.id
      if (isObject(call.function)) {
        if (
          typeof call.function.name === 'string' &&
          call.function.name !== '' &&
          slot.name !== '' &&
          slot.name !== call.function.name
        ) {
          outcome.error = 'upstream tool fragment changed name'
          return
        }
        if (typeof call.function.name === 'string' && call.function.name !== '' && slot.name === '')
          slot.name = call.function.name
        if (typeof call.function.arguments === 'string') slot.arguments += call.function.arguments
      }
    }
  }
}

/**
 * `content_filter` maps to `refusal`, not `end_turn`: an upstream that refused
 * the turn must not look like a model that simply finished without saying
 * anything — clients surface the two very differently.
 */
const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

function stopReasonFor(outcome: Outcome): string {
  if (outcome.toolCalls.length > 0) return 'tool_use'
  return STOP_REASONS[outcome.finishReason ?? ''] ?? 'end_turn'
}

/** Accumulated outcome → non-streaming Anthropic message body. */
export function anthropicMessage(
  outcome: Outcome,
  {
    model,
    id,
    inputTokens = 0,
    showThinking = false,
  }: { model: string; id: string; inputTokens?: number; showThinking?: boolean },
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []
  if (showThinking && outcome.thinking !== '') {
    content.push({ type: 'thinking', thinking: outcome.thinking, signature: TRANSLATED_THINKING_SIGNATURE })
  }
  if (outcome.text !== '') content.push({ type: 'text', text: outcome.text })
  for (const call of outcome.toolCalls.filter(Boolean)) {
    if (call.name === '') throw new Error('upstream tool call has no name')
    const input = toolInput(call.arguments)
    content.push({ type: 'tool_use', id: call.id || 'toolu_0', name: call.name, input })
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonFor(outcome),
    stop_sequence: null,
    usage: anthropicUsageFrom(outcome.usage, {
      inputTokens,
      outputTokens: Math.round(outcome.text.length / CHARS_PER_TOKEN),
    }),
  }
}

/**
 * Streaming renderer: turns an OpenAI chunk stream into Anthropic's named event
 * stream.
 *
 * `write` receives a complete SSE frame as a string and the caller only has to
 * put it on the socket — which is what makes "is the framing correct" assertable
 * without a network.
 *
 * `begin()` is separate from the first chunk: a reasoning model can think for
 * tens of seconds without emitting anything, while the Anthropic contract emits
 * `message_start` as soon as the stream opens. The server calls it on a 200 so
 * the client never sits on "connecting".
 */
export function createStreamTranslator({
  model,
  id,
  write,
  showThinking = false,
  inputTokens = 0,
}: StreamTranslatorOptions): StreamTranslator {
  let nextIndex = 0
  let textIndex: number | null = null
  let thinkingIndex: number | null = null
  /** A tool block being assembled; `block` is -1 until the name makes it openable. */
  interface ToolSlot {
    block: number
    id: string
    name: string
    open: boolean
    buffer: string
    arguments: string
  }
  const toolSlots = new Map<number, ToolSlot>()
  // Raw upstream usage, merged field-wise because some upstreams (vLLM's
  // `continuous_usage_stats`) repeat it on intermediate chunks. Anthropic counts cache
  // buckets *outside* `input_tokens` while the upstream counts them inside
  // `prompt_tokens`; `anthropicUsageFrom` performs that split at read time.
  const upstreamUsage: Record<string, unknown> = {}
  let stopReason: string | null = null
  let started = false
  let finished = false
  let error: string | undefined = undefined
  let deferredText = ''

  const send = (event: string, payload: unknown): void => write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)

  const usageNow = (): AnthropicUsage => anthropicUsageFrom(upstreamUsage, { inputTokens, outputTokens: 0 })

  function mergeUsage(incoming: unknown): void {
    if (!isObject(incoming)) return
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue
      upstreamUsage[key] = isObject(value)
        ? { ...(isObject(upstreamUsage[key]) ? (upstreamUsage[key] as Record<string, unknown>) : {}), ...value }
        : value
    }
  }

  function start() {
    if (started) return
    started = true
    send('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usageNow(), output_tokens: 0 },
      },
    })
  }

  /**
   * Thinking has no upstream signature, but the block contract requires one (an empty
   * string makes clients reject the history they are handed back). The shortest valid
   * base64 value is enough: signatures are opaque to the client.
   */
  function closeThinking() {
    if (thinkingIndex === null) return
    send('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingIndex,
      delta: { type: 'signature_delta', signature: TRANSLATED_THINKING_SIGNATURE },
    })
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

  /** Thinking and text blocks are mutually exclusive: Anthropic's block order is production order. */
  function thinkingDelta(text: string): void {
    if (!showThinking || text === '') return
    closeText()
    if (thinkingIndex === null) {
      thinkingIndex = nextIndex++
      send('content_block_start', {
        type: 'content_block_start',
        index: thinkingIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })
    }
    send('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingIndex,
      delta: { type: 'thinking_delta', thinking: text },
    })
  }

  function textDelta(text: string): void {
    if (text === '') return
    if ([...toolSlots.values()].some(slot => slot.open)) {
      deferredText += text
      return
    }
    closeThinking()
    if (textIndex === null) {
      textIndex = nextIndex++
      send('content_block_start', {
        type: 'content_block_start',
        index: textIndex,
        content_block: { type: 'text', text: '' },
      })
    }
    send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } })
  }

  /**
   * A tool block must open with its name, so arguments that arrive first are
   * buffered — some upstreams emit `arguments` before `name`, and opening the
   * block eagerly yields an anonymous tool call Claude Code cannot send back.
   */
  function openTool(slot: ToolSlot): void {
    if (slot.open || slot.name === '') return
    slot.open = true
    slot.block = nextIndex++
    send('content_block_start', {
      type: 'content_block_start',
      index: slot.block,
      content_block: { type: 'tool_use', id: slot.id || `toolu_${slot.block}`, name: slot.name, input: {} },
    })
    if (slot.buffer !== '') {
      send('content_block_delta', {
        type: 'content_block_delta',
        index: slot.block,
        delta: { type: 'input_json_delta', partial_json: slot.buffer },
      })
      slot.buffer = ''
    }
  }

  function toolDelta(call: Record<string, unknown>): void {
    closeThinking()
    closeText()
    const key = resolveToolIndex(call, [...toolSlots.entries()])
    let slot = toolSlots.get(key)
    if (slot === undefined) {
      slot = {
        block: -1,
        id: typeof call.id === 'string' && call.id !== '' ? call.id : '',
        name: '',
        open: false,
        buffer: '',
        arguments: '',
      }
      toolSlots.set(key, slot)
    } else if (typeof call.id === 'string' && call.id !== '') {
      if (slot.id !== '' && slot.id !== call.id) throw new Error('upstream tool index changed identity')
      slot.id = call.id
    }
    const fn = isObject(call.function) ? call.function : {}
    if (typeof fn.name === 'string' && fn.name !== '' && slot.name !== '' && slot.name !== fn.name)
      throw new Error('upstream tool fragment changed name')
    if (typeof fn.name === 'string' && fn.name !== '' && slot.name === '') slot.name = fn.name
    const args = typeof fn.arguments === 'string' ? fn.arguments : ''
    slot.arguments += args
    if (args !== '') {
      if (slot.open)
        send('content_block_delta', {
          type: 'content_block_delta',
          index: slot.block,
          delta: { type: 'input_json_delta', partial_json: args },
        })
      else slot.buffer += args
    }
    openTool(slot)
  }

  return {
    /** Emit `message_start` now, before the upstream has produced anything. Idempotent. */
    begin: start,
    /** Consume one OpenAI chunk; returning false means this chunk declared a failure. */
    push(chunk: unknown): boolean {
      if (finished || !isObject(chunk)) return true
      if (isObject(chunk.error)) {
        error = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error)
        return false
      }
      mergeUsage(chunk.usage)
      start()
      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (!isObject(choice)) continue
        if (typeof choice.finish_reason === 'string') stopReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn'
        const delta = isObject(choice.delta) ? choice.delta : {}
        const reasoning =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : ''
        thinkingDelta(reasoning)
        if (typeof delta.content === 'string' && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
          deferredText += delta.content
        else if (typeof delta.content === 'string') textDelta(delta.content)
        else if (Array.isArray(delta.content)) {
          for (const part of delta.content)
            if (isObject(part)) {
              if (typeof part.text === 'string') textDelta(part.text)
              else if (typeof part.refusal === 'string') textDelta(part.refusal)
            }
        }
        if (typeof delta.refusal === 'string') textDelta(delta.refusal)
        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
        if (calls.filter(call => isObject(call) && !Number.isInteger(call.index) && !call.id).length > 1) {
          error = 'upstream tool fragments cannot be matched to parallel calls'
          return false
        }
        for (const call of calls) {
          if (!isObject(call)) continue
          try {
            toolDelta(call)
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            return false
          }
        }
      }
      return true
    },
    /** Normal finish: close open blocks, emit stop_reason and usage, then message_stop. */
    end(): void {
      if (finished) return
      try {
        for (const slot of toolSlots.values()) {
          if (slot.name === '') throw new Error('upstream tool call has no name')
          toolInput(slot.arguments)
        }
      } catch (cause) {
        this.fail(cause instanceof Error ? cause.message : String(cause))
        return
      }
      start()
      finished = true
      closeThinking()
      closeText()
      // Tool blocks still unopened at finish: open them once the name has arrived,
      // ordered by the upstream's own index.
      for (const slot of [...toolSlots.values()].sort((a, b) => a.block - b.block)) {
        if (slot.open || slot.buffer === '') continue
        if (slot.name === '') slot.name = 'unknown_tool'
        openTool(slot)
      }
      closeTools()
      if (deferredText !== '') {
        textDelta(deferredText)
        closeText()
      }
      const reason = toolSlots.size > 0 ? 'tool_use' : error !== undefined ? 'end_turn' : (stopReason ?? 'end_turn')
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        usage: usageNow(),
      })
      send('message_stop', { type: 'message_stop' })
    },
    /** Failure finish: Anthropic reports "failed after headers were sent" as an in-stream error event. */
    fail(message: unknown): void {
      if (finished) return
      start()
      finished = true
      send('error', { type: 'error', error: { type: 'api_error', message: String(message) } })
      send('message_stop', { type: 'message_stop' })
    },
    get failure(): string | undefined {
      return error
    },
    get usage(): AnthropicUsage {
      return usageNow()
    },
    get upstreamInputTokens(): number | undefined {
      const value = upstreamUsage.prompt_tokens
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    },
  }
}

/** Anthropic's error envelope. */
/** Anthropic's error envelope. `requestId` is optional so callers that have none stay unchanged. */
export function errorBody(type: string, message: string, requestId?: string): ApiError {
  return {
    type: 'error',
    error: { type, message },
    ...(requestId === undefined ? {} : { request_id: requestId }),
  }
}
