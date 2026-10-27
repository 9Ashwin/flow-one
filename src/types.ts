// Shapes shared between modules.
//
// Types only: this file must never import anything at runtime, so nothing can
// depend on it in a way that forms a cycle (`check-modules.ts` keeps it at
// layer 0). Everywhere else imports from here with `import type`.

/** The closed set of error categories; the exit code is derived from it alone. */
export type Category = 'validation' | 'auth' | 'config' | 'network' | 'upstream' | 'internal'

/** One-line JSON envelope written to stderr under `--json`. */
export interface ErrorEnvelope {
  ok: false
  error: {
    type: Category
    subtype: string
    code?: number
    param?: string
    hint?: string
    message: string
  }
}

/** Anthropic's error body (`errorBody` in `anthropic.ts`). */
export interface ApiError {
  type: 'error'
  error: { type: string; message: string }
  /** Correlation id; the same value appears in this bridge's log line for the turn. */
  request_id?: string
}

/**
 * A Tencent product line (domestic CodeBuddy / international WorkBuddy).
 *
 * The per-model User-Agent table exists because the international backend
 * attributes domestic model lines only when they arrive in the domestic client
 * shape.
 */
export interface Product {
  id: string
  auth: 'oauth' | 'none' | 'key'
  label: string
  hint?: string
  platform: string
  endpoint: string
  apiDomain: string
  productCode: string
  attributionName: string
  clientVersion: string
  userAgent: string
  userAgentByModel: ReadonlyArray<readonly [string, string]>
  sessionParams: boolean
  pluginVersion?: string
  fallbackModels: readonly string[]
  /** Product entries have no wire-shape discriminator; declaring it keeps `Source` narrowable. */
  kind?: undefined
}

/** An OpenCode entry (free anonymous tier or the Go subscription). */
export interface OpenCodeSource {
  id: string
  kind: 'openai'
  auth: 'oauth' | 'none' | 'key'
  label: string
  hint: string
  baseUrl: string
  chatPath: string
  modelsPath: string
  defaultModel: string
  anonymousKey?: string
  defaultUserAgent?: string
  sessionHeader?: string
  modelsDevUrl?: string
  modelsDevTtlMs?: number
  /** Product entries have no `kind`; declaring it here keeps the union discriminating. */
  platform?: undefined
}

/** Any mountable origin. `kind` tells the two wire shapes apart. */
export type Source = Product | OpenCodeSource

/** Account details returned by `/v2/plugin/login/account`. */
export interface Account {
  uid?: string
  nickname?: string
  enterpriseId?: string
  type?: string
}

/**
 * One credential entry in `credentials.json`.
 *
 * The Tencent entries carry an access/refresh token pair with an expiry;
 * the OpenCode Go entry carries only an API key and a session id, so the
 * token fields stay optional rather than being split into a second store.
 */
export interface Credential {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  domain?: string
  tokenType?: string
  account?: Account
  apiKey?: string
  session?: string
  /** Last four characters of an API key, kept for display only. */
  tail?: string
  savedAt?: string
}

/** Whole `credentials.json` file, keyed by source id. */
export type CredentialStore = Record<string, Credential>

/**
 * Resolved configuration (`resolveConfig`).
 *
 * Fields the bridge server and the upstreams merely tolerate being absent are
 * optional: tests build partial configs, and a missing `heartbeatMs` really
 * does mean "no heartbeat".
 */
export interface BridgeConfig {
  mode?: 'direct' | 'gateway'
  host: string
  port: number
  upstream?: string
  upstreamKey?: string
  upstreamKeyPath?: string | null
  model: string
  apiKey: string
  modelMap: Record<string, string>
  maxTokensCap?: number
  showThinking?: boolean
  heartbeatMs?: number
  upstreamIdleMs?: number
  dshReasoning?: string
  fingerprintRewrite?: boolean
  products?: Source[]
  quiet?: boolean
  json?: boolean
  service?: boolean
  clients?: string[]
  credentialFile?: string
  home?: string
}

/** One row of the model catalogue, as the upstreams report it. */
export interface UpstreamModel {
  id: string
  name?: string
  /** Wire-level input kinds, when the upstream declares them (`text`, `image`, …). */
  input?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  efforts?: string[]
  free?: boolean
  product?: string
}

/** OpenAI-shaped chunks, already decoded from SSE. */
export type ChatChunks = AsyncIterable<unknown>

export interface ChatSuccess {
  ok: true
  chunks: ChatChunks
}

export interface ChatFailure {
  ok: false
  status?: number
  message: string
  /** Only the server sets this: whether a retry before any byte is safe. */
  retryable?: boolean
  /**
   * Which sources failed before this one answered.
   *
   * With several mounted sources a bare "401" does not say *which* line is broken;
   * carrying the earlier failures lets the final error name them instead of
   * silently reporting only the last attempt.
   */
  attempts?: Array<{ upstream: string; status?: number; message: string }>
}

export type ChatResult = ChatSuccess | ChatFailure

/** Anything that can answer a chat turn and list models. */
export interface Upstream {
  name?: string
  describe(): string
  loadModels(): Promise<UpstreamModel[]>
  chat(body: OpenAiRequestBody, options?: { signal?: AbortSignal }): Promise<ChatResult>
}

export type OpenAiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export interface OpenAiMessage {
  role: string
  content: string | OpenAiContentPart[]
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

export type OpenAiToolChoice = string | { type: 'function'; function: { name: string } }

export interface OpenAiRequestBody {
  model?: string
  /**
   * Optional because the gate helpers are also called with shape-only fixtures (no
   * conversation) when probing the free tier's requirements.
   */
  messages?: OpenAiMessage[]
  tools?: OpenAiTool[]
  tool_choice?: OpenAiToolChoice
  parallel_tool_calls?: boolean
  response_format?: {
    type: 'json_schema'
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> }
  }
  stream?: boolean
  stream_options?: { include_usage: boolean }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  reasoning_effort?: string
  /** Anthropic fast mode -> the upstream's priority lane. */
  service_tier?: string
}

/** `system` rewriter applied to requests headed for Tencent's backend. */
export type SystemRewriter = (text: string) => string

/** Options of `toOpenAiRequest`. */
export interface ToOpenAiRequestOptions {
  model?: string
  maxTokensCap?: number
  rewriteSystem?: SystemRewriter
  supportsImages?: boolean
}

/**
 * Either a translated body or the reason the request is a 400.
 *
 * The variant without `error` is what callers narrow to after checking
 * `error !== undefined`.
 */
export type RequestTranslation = { body: OpenAiRequestBody; error?: undefined } | { body?: undefined; error: string }

/**
 * Anthropic's usage counters.
 *
 * The cache fields are written only when the upstream reported them: Anthropic
 * uses `null` for "not applicable", and a literal 0 would read as "caching
 * exists but never hit".
 */
export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens: number }
}

export type AnthropicContentBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string
  stop_sequence: null
  usage: AnthropicUsage
}

/** One accumulated tool call; arguments arrive in fragments across chunks. */
export interface ToolCallSlot {
  id: string
  name: string
  arguments: string
}

/**
 * The fold shared by streaming and non-streaming responses.
 *
 * `usage` stays `unknown` because upstreams report their own field names; it is
 * narrowed in `anthropicUsageFrom`.
 */
export interface Outcome {
  text: string
  thinking: string
  toolCalls: ToolCallSlot[]
  usage: unknown
  finishReason: string | undefined
  error: string | undefined
}

export interface StreamTranslatorOptions {
  model: string
  id: string
  /** Receives one complete SSE frame; must stay synchronous (frame order is the contract). */
  write: (frame: string) => void
  showThinking?: boolean
  inputTokens?: number
}

export interface StreamTranslator {
  /** Emit `message_start` now, before the upstream produced anything. Idempotent. */
  begin(): void
  /** Consume one OpenAI chunk; false means this chunk declared a failure. */
  push(chunk: unknown): boolean
  /** Normal finish: close open blocks, emit stop_reason and usage, then message_stop. */
  end(): void
  /** Failure finish: report as an in-stream `error` event. */
  fail(message: unknown): void
  readonly failure: string | undefined
  readonly usage: AnthropicUsage
}
