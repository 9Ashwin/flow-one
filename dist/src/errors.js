// The error contract: a closed category set, a closed subtype set, exit-code derivation and
// stderr rendering.
//
// **Every** failure at a command boundary must be a {@link BridgeError}: a bare
// `new Error('…')` leaves callers branching on message text, which is no contract at all
// (AGENTS.md "error contract" is the single source of truth for this). The callers are
// scripts, so the field names and values below are **wire contract — renaming one breaks
// compatibility**.
//
// Four rules, do not mix them:
//
//   - `category` is a closed set, and **the exit code derives from it alone**
//     ({@link exitCodeFor}) — never from the subtype, never from the message;
//   - `subtype` is a closed set of lowercase-with-underscores names. Constructing an
//     undeclared subtype throws on the spot — a typo has to surface at construction time,
//     not later in production where a script branch silently fails to match;
//   - `code` only carries an **upstream** numeric code (Tencent's `11128`, an HTTP status
//     code), never internal meaning; `param` only says which piece of user input is
//     invalid; `hint` only carries the **recovery action** (put the fix here, not in the
//     message); `message` states in one sentence what happened;
//   - wrapping is idempotent: an error that is already a contract error is returned
//     unchanged ({@link toBridgeError}); no second layer.
//
// Field names and values mirror the Go version (`go-rewrite` branch, `errs/`) one to one,
// **with one deliberate difference**: Go's auth wire value is `"authentication"` while
// AGENTS.md in this repository specifies `"auth"`; the latter wins.
/**
 * The closed category set. The wire field name is `type`, but this program calls it category
 * everywhere (do not confuse it with subtype).
 */
export const CATEGORIES = Object.freeze({
    /** Invalid user input: a flag, an argument, a model name. */
    VALIDATION: 'validation',
    /** Not logged in, credentials expired, key missing. */
    AUTH: 'auth',
    /** Configuration missing or self-contradictory: settings.json, the service file, the ledger. */
    CONFIG: 'config',
    /** Cannot connect, timed out, the read stream failed (**no response was obtained**). */
    NETWORK: 'network',
    /**
     * The upstream explicitly refused: content filter, gate, quota, model unavailable (a
     * response arrived, but it is a failure).
     */
    UPSTREAM: 'upstream',
    /** A bug in this program (should not happen). */
    INTERNAL: 'internal',
});
/** category → exit code. */
const EXIT_CODES = Object.freeze({
    validation: 2,
    auth: 3,
    config: 4,
    network: 5,
    upstream: 6,
    internal: 1,
});
/**
 * The **only** place an exit code is derived. An unknown category degrades to 1 — but the
 * normal path never gets here: construction already rejects a category outside the closed
 * set (see {@link BridgeError}).
 */
export function exitCodeFor(category) {
    return EXIT_CODES[category] ?? 1;
}
/**
 * The closed subtype set: lowercase with underscores. Scripts and tests branch on these, so
 * **renaming one breaks compatibility**.
 *
 * Keys map one to one onto the constants in the Go version's `subtypes.go`, and the values
 * are byte-for-byte identical.
 */
export const SUBTYPES = Object.freeze({
    INVALID_FLAG: 'invalid_flag',
    INVALID_MODEL: 'invalid_model',
    INVALID_PORT: 'invalid_port',
    INVALID_UPSTREAM_URL: 'invalid_upstream_url',
    UNKNOWN_SOURCE: 'unknown_source',
    MISSING_ARGUMENT: 'missing_argument',
    INVALID_REQUEST: 'invalid_request',
    NOT_LOGGED_IN: 'not_logged_in',
    LOGIN_FAILED: 'login_failed',
    LOGIN_TIMEOUT: 'login_timeout',
    MISSING_API_KEY: 'missing_api_key',
    REFRESH_FAILED: 'refresh_failed',
    SETTINGS_MISSING: 'settings_missing',
    SETTINGS_INCONSISTENT: 'settings_inconsistent',
    SERVICE_CODE_MISMATCH: 'service_code_mismatch',
    NO_SOURCES: 'no_sources',
    SERVICE_UNSUPPORTED: 'service_unsupported',
    SESSION_UNAVAILABLE: 'session_unavailable',
    CONNECT_FAILED: 'connect_failed',
    TIMEOUT: 'timeout',
    BAD_STATUS: 'bad_status',
    /** Tencent content filter: 400 + code 11128. */
    CONTENT_BLOCKED: 'content_blocked',
    /** OpenCode free tier gate: FreeTierError. */
    SHAPE_REJECTED: 'shape_rejected',
    /** OpenCode Go: missing x-opencode-session. */
    MISSING_SESSION: 'missing_session',
    /** Quota / rate limited (not a gate problem). */
    QUOTA_LIMITED: 'quota_limited',
    MODEL_UNAVAILABLE: 'model_unavailable',
    UNEXPECTED: 'unexpected',
    IO_FAILED: 'io_failed',
    PARSE_FAILED: 'parse_failed',
});
const DECLARED_SUBTYPES = new Set(Object.values(SUBTYPES));
/** Whether this subtype was declared in the closed set. */
export function isDeclaredSubtype(subtype) {
    return DECLARED_SUBTYPES.has(subtype);
}
/**
 * A categorised error. Every failure at a command boundary should be one.
 *
 * The chained setters (`withCode` / `withParam` / `withHint` / `withCause`) mutate in place
 * and return `this`, so construction plus field filling fits in one statement.
 */
export class BridgeError extends Error {
    name = 'BridgeError';
    /** One of {@link CATEGORIES}; a value outside the closed set is rejected at construction. */
    category;
    subtype;
    /**
     * Upstream numeric code; left unset when none was obtained (then it is absent from the
     * envelope).
     */
    code = undefined;
    /** Which piece of user input is invalid (`--port` / `BRIDGE_PORT`). */
    param = '';
    /** The recovery action. Put the fix here, not in the message. */
    hint = '';
    /** Cause chain: `internalFrom` hangs the original exception here. */
    cause = undefined;
    /**
     * @param category one of {@link CATEGORIES}
     * @param subtype one of {@link SUBTYPES}
     * @param message one sentence stating what happened
     */
    constructor(category, subtype, message) {
        // The closed sets have to be enforced at construction: a mistyped category makes the
        // exit code silently degrade to 1, and a mistyped subtype makes every script branch
        // miss forever — neither should wait for production to be noticed.
        if (!Object.values(CATEGORIES).includes(category))
            throw new Error(`errors: undeclared category: ${category}`);
        if (!isDeclaredSubtype(subtype))
            throw new Error(`errors: undeclared subtype: ${subtype}`);
        super(message);
        this.category = category;
        this.subtype = subtype;
    }
    withCode(code) {
        this.code = code;
        return this;
    }
    withParam(param) {
        this.param = param ?? '';
        return this;
    }
    withHint(hint) {
        this.hint = hint ?? '';
        return this;
    }
    withCause(cause) {
        this.cause = cause;
        return this;
    }
}
export const validationError = (subtype, message) => new BridgeError(CATEGORIES.VALIDATION, subtype, message);
export const authError = (subtype, message) => new BridgeError(CATEGORIES.AUTH, subtype, message);
export const configError = (subtype, message) => new BridgeError(CATEGORIES.CONFIG, subtype, message);
export const networkError = (subtype, message) => new BridgeError(CATEGORIES.NETWORK, subtype, message);
export const upstreamError = (subtype, message) => new BridgeError(CATEGORIES.UPSTREAM, subtype, message);
export const internalError = (subtype, message) => new BridgeError(CATEGORIES.INTERNAL, subtype, message);
/** Return the contract error, or undefined when it is not one. */
export function asBridgeError(error) {
    return error instanceof BridgeError ? error : undefined;
}
/** Collapse an "impossible" error into internal/unexpected, keeping the cause chain and stack. */
export function internalFrom(cause) {
    const typed = asBridgeError(cause);
    if (typed !== undefined)
        return typed;
    return internalError(SUBTYPES.UNEXPECTED, `internal error: ${describe(cause)}`).withCause(cause);
}
/**
 * Collapse any exception into a contract error: one that already is a contract error is
 * **returned unchanged** (wrapping is idempotent), anything else becomes
 * internal/unexpected. Command boundaries call only this one; they must not branch on
 * `instanceof` themselves.
 */
export function toBridgeError(error) {
    return asBridgeError(error) ?? internalFrom(error);
}
/**
 * The object shape of the one-line JSON envelope. Empty fields are absent: no `code` /
 * `param` / `hint` means the key is not there.
 *
 * The key order matches the Go version (type, subtype, code, param, hint, message) so
 * consumers can read line by line.
 */
export function envelope(error) {
    const typed = toBridgeError(error);
    // 0 is the equivalent of Go's omitempty: no upstream code means no code — do not emit a fake 0.
    const code = Number.isFinite(typed.code) && typed.code !== 0 ? typed.code : undefined;
    const problem = {
        type: typed.category,
        subtype: typed.subtype,
        ...(code !== undefined ? { code } : {}),
        ...(typed.param !== '' ? { param: typed.param } : {}),
        ...(typed.hint !== '' ? { hint: typed.hint } : {}),
        message: typed.message,
    };
    return { ok: false, error: problem };
}
/**
 * Render the text to write to **stderr** (including the trailing newline).
 *
 * - default (human-readable): `Error: <message>`, then `  → <hint>` on its own line when a
 *   hint is present;
 * - `json`: exactly one line of JSON envelope — scripts read it line by line, and a second
 *   line breaks the contract;
 * - an unexpected exception (not a contract error) additionally prints its **original
 *   stack**: swallowing it leaves debugging to guesswork. Typed errors do not print a
 *   stack; the two contract lines are enough.
 */
export function renderError(error, { json = false } = {}) {
    const typed = toBridgeError(error);
    if (json)
        return `${JSON.stringify(envelope(typed))}\n`;
    let text = `Error: ${summary(typed)}`;
    if (typed.hint !== '')
        text += `\n  → ${typed.hint}`;
    if (typed.cause !== undefined && !(typed.cause instanceof BridgeError)) {
        text += `\n${typed.cause instanceof Error ? typed.cause.stack : String(typed.cause)}`;
    }
    return `${text}\n`;
}
/** Degrade to `category/subtype` when the message is empty; never render a bare `Error: `. */
function summary(error) {
    return error.message !== '' ? error.message : `${error.category}/${error.subtype}`;
}
/**
 * The `<cause>` in `internal error: <cause>`: an Error contributes its message, anything else
 * `String(...)`.
 */
function describe(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
