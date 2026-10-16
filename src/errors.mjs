/**
 * 错误契约：分类闭集、subtype 闭集、退出码推导与 stderr 渲染。
 *
 * 命令边界的**任何**失败都必须是 {@link BridgeError}：裸 `new Error('…')` 让消费方
 * 只能靠 message 文本分支，那等于没有契约（AGENTS.md「错误契约」是这件事的唯一事实
 * 来源）。消费方是脚本，所以下面这些字段名与取值都是**线上契约，改名即破坏兼容**。
 *
 * 四条规矩，别混：
 *
 *   - `category` 闭集，**退出码只由它推导**（{@link exitCodeFor}），不看 subtype、
 *     不看 message；
 *   - `subtype` 小写下划线，闭集。构造未声明的 subtype 直接抛 —— 拼错的名字要在
 *     构造期暴露，而不是等线上发现脚本分支匹配不上；
 *   - `code` 只放**上游**的数字码（腾讯 `11128`、HTTP 状态码），不承载本程序内部
 *     含义；`param` 只说明哪一项用户输入不合法；`hint` 只放**恢复动作**（修法写这里，
 *     不要塞进 message）；`message` 一句话说明发生了什么；
 *   - 包装幂等：已经是契约错误就原样返回（{@link toBridgeError}），不套第二层。
 *
 * 字段名与取值跟 Go 版（`go-rewrite` 分支 `errs/`）逐一对齐，**只有一处刻意不同**：
 * Go 的 auth 线上值是 `"authentication"`，本仓 AGENTS.md 定的是 `"auth"`，以后者为准。
 *
 * @module src/errors.mjs
 */

/** category 闭集。线上字段名是 `type`，但本程序里一律叫 category（别把它跟 subtype 混）。 */
export const CATEGORIES = Object.freeze({
  /** 用户输入不合法：flag、参数、模型名。 */
  VALIDATION: 'validation',
  /** 没登录、凭据失效、缺 key。 */
  AUTH: 'auth',
  /** 配置缺失或自相矛盾：settings.json、服务文件、账本。 */
  CONFIG: 'config',
  /** 连不上、超时、读流出错（**没拿到应答**）。 */
  NETWORK: 'network',
  /** 上游明确拒绝：内容风控、门禁、额度、模型不可用（拿到了应答，但应答是失败）。 */
  UPSTREAM: 'upstream',
  /** 本程序自己的 bug（不该发生）。 */
  INTERNAL: 'internal',
})

/** category → 退出码。 */
const EXIT_CODES = Object.freeze({
  validation: 2,
  auth: 3,
  config: 4,
  network: 5,
  upstream: 6,
  internal: 1,
})

/**
 * 退出码的**唯一**推导入口。不认识的分类退化成 1 —— 但正常路径上到不了这里：
 * 构造期就挡住了闭集外的 category（见 {@link BridgeError}）。
 */
export function exitCodeFor(category) {
  return EXIT_CODES[category] ?? 1
}

/**
 * subtype 闭集：小写下划线。脚本与测试按它分支，所以**改名即破坏兼容**。
 *
 * 键与 Go 版 `subtypes.go` 的常量一一对应，值逐字节相同。
 */
export const SUBTYPES = Object.freeze({
  // ── validation：用户输入 ──
  INVALID_FLAG: 'invalid_flag',
  INVALID_MODEL: 'invalid_model',
  INVALID_PORT: 'invalid_port',
  INVALID_UPSTREAM_URL: 'invalid_upstream_url',
  UNKNOWN_SOURCE: 'unknown_source',
  MISSING_ARGUMENT: 'missing_argument',
  INVALID_REQUEST: 'invalid_request',

  // ── auth：没登录、凭据失效、缺 key ──
  NOT_LOGGED_IN: 'not_logged_in',
  LOGIN_FAILED: 'login_failed',
  LOGIN_TIMEOUT: 'login_timeout',
  MISSING_API_KEY: 'missing_api_key',
  REFRESH_FAILED: 'refresh_failed',

  // ── config：文件里读出来的配置 ──
  SETTINGS_MISSING: 'settings_missing',
  SETTINGS_INCONSISTENT: 'settings_inconsistent',
  SERVICE_CODE_MISMATCH: 'service_code_mismatch',
  NO_SOURCES: 'no_sources',
  SERVICE_UNSUPPORTED: 'service_unsupported',
  SESSION_UNAVAILABLE: 'session_unavailable',

  // ── network：没拿到应答 ──
  CONNECT_FAILED: 'connect_failed',
  TIMEOUT: 'timeout',

  // ── upstream：拿到应答但被拒 ──
  BAD_STATUS: 'bad_status',
  /** 腾讯内容风控：400 + code 11128。 */
  CONTENT_BLOCKED: 'content_blocked',
  /** OpenCode 免费档门禁：FreeTierError。 */
  SHAPE_REJECTED: 'shape_rejected',
  /** OpenCode Go：缺 x-opencode-session。 */
  MISSING_SESSION: 'missing_session',
  /** 额度 / 频率受限（不是门禁问题）。 */
  QUOTA_LIMITED: 'quota_limited',
  MODEL_UNAVAILABLE: 'model_unavailable',

  // ── internal：本程序自己的 bug ──
  UNEXPECTED: 'unexpected',
  IO_FAILED: 'io_failed',
  PARSE_FAILED: 'parse_failed',
})

const DECLARED_SUBTYPES = new Set(Object.values(SUBTYPES))

/** 这个 subtype 是不是闭集里声明过的。 */
export function isDeclaredSubtype(subtype) {
  return DECLARED_SUBTYPES.has(subtype)
}

/**
 * 带分类的错误。命令边界的失败都该是它。
 *
 * 链式补充方法（`withCode` / `withParam` / `withHint` / `withCause`）就地改自己并返回
 * `this`，方便一条语句写完构造 + 补字段。
 */
export class BridgeError extends Error {
  /**
   * @param {string} category {@link CATEGORIES} 里的一员
   * @param {string} subtype {@link SUBTYPES} 里的一员
   * @param {string} message 一句话说明发生了什么
   */
  constructor(category, subtype, message) {
    // 闭集要在构造期收口：拼错的 category 会让退出码静默退化成 1，拼错的 subtype
    // 会让脚本分支永远匹配不上 —— 两种都不该等到线上才发现。
    if (!Object.values(CATEGORIES).includes(category)) throw new Error(`errors: 未声明的 category：${category}`)
    if (!isDeclaredSubtype(subtype)) throw new Error(`errors: 未声明的 subtype：${subtype}`)
    super(message)
    this.name = 'BridgeError'
    this.category = category
    this.subtype = subtype
    /** 上游数字码；没拿到就不设（信封里不出现）。 */
    this.code = undefined
    /** 哪一项用户输入不合法（`--port` / `BRIDGE_PORT`）。 */
    this.param = ''
    /** 恢复动作。修法写这里，不要塞进 message。 */
    this.hint = ''
    /** 原因链：`internalFrom` 会把原始异常挂在这里。 */
    this.cause = undefined
  }

  withCode(code) { this.code = code; return this }
  withParam(param) { this.param = param ?? ''; return this }
  withHint(hint) { this.hint = hint ?? ''; return this }
  withCause(cause) { this.cause = cause; return this }
}

// ── 分类构造器：命令边界应当用这些，而不是裸 new Error ──────────────────────

export const validationError = (subtype, message) => new BridgeError(CATEGORIES.VALIDATION, subtype, message)
export const authError = (subtype, message) => new BridgeError(CATEGORIES.AUTH, subtype, message)
export const configError = (subtype, message) => new BridgeError(CATEGORIES.CONFIG, subtype, message)
export const networkError = (subtype, message) => new BridgeError(CATEGORIES.NETWORK, subtype, message)
export const upstreamError = (subtype, message) => new BridgeError(CATEGORIES.UPSTREAM, subtype, message)
export const internalError = (subtype, message) => new BridgeError(CATEGORIES.INTERNAL, subtype, message)

/** 取出契约错误；不是就返回 undefined。 */
export function asBridgeError(error) {
  return error instanceof BridgeError ? error : undefined
}

/** 把「不该发生的错误」收敛成 internal/unexpected，原因链与堆栈都留着。 */
export function internalFrom(cause) {
  const typed = asBridgeError(cause)
  if (typed !== undefined) return typed
  return internalError(SUBTYPES.UNEXPECTED, `内部错误：${describe(cause)}`).withCause(cause)
}

/**
 * 把任意异常收敛成契约错误：已经是契约错误就**原样返回**（包装幂等），否则落到
 * internal/unexpected。命令边界只调这一个，不许自己 `instanceof` 分支。
 */
export function toBridgeError(error) {
  return asBridgeError(error) ?? internalFrom(error)
}

/**
 * 一行 JSON 信封的对象形状。空字段不出现：`code` / `param` / `hint` 没有就没有。
 *
 * 键序与 Go 版一致（type、subtype、code、param、hint、message），消费方按行读。
 */
export function envelope(error) {
  const typed = toBridgeError(error)
  const problem = { type: typed.category, subtype: typed.subtype }
  // 0 与 Go 版 omitempty 等价：没有上游码就是没有，别写一个假的 0 出来。
  if (Number.isFinite(typed.code) && typed.code !== 0) problem.code = typed.code
  if (typed.param !== '') problem.param = typed.param
  if (typed.hint !== '') problem.hint = typed.hint
  problem.message = typed.message
  return { ok: false, error: problem }
}

/**
 * 渲染成要写到 **stderr** 的文本（含结尾换行）。
 *
 * - 默认（人读）：`Error: <message>`，有 hint 时另起一行 `  → <hint>`；
 * - `json`：恰好一行 JSON 信封 —— 脚本逐行读，多一行就破了契约；
 * - 未预期的异常（非契约错误）额外带出**原始堆栈**：吞掉它排障就只能靠猜。已类型化
 *   的错误不打印堆栈，契约里的那两行就够了。
 */
export function renderError(error, { json = false } = {}) {
  const typed = toBridgeError(error)
  if (json) return `${JSON.stringify(envelope(typed))}\n`
  let text = `Error: ${summary(typed)}`
  if (typed.hint !== '') text += `\n  → ${typed.hint}`
  if (typed.cause !== undefined && !(typed.cause instanceof BridgeError)) {
    text += `\n${typed.cause instanceof Error ? typed.cause.stack : String(typed.cause)}`
  }
  return `${text}\n`
}

/** message 为空时退化成 `category/subtype`，别渲染出一行空的 `Error: `。 */
function summary(error) {
  return error.message !== '' ? error.message : `${error.category}/${error.subtype}`
}

/** `内部错误：<cause>` 里那个 `<cause>`：Error 取 message，其余照 String。 */
function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}
