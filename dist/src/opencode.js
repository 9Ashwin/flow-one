// The OpenCode free model channel (`opencode.ai/inference`).
//
// ## Why it works, and why "just add a base URL" is not enough
//
// The anonymous tier (`Authorization: Bearer public`) does list 88 models, but **a
// plain standard OpenAI request is rejected**:
//
// ```
// {"type":"error","error":{"type":"FreeTierError",
//  "message":"OpenCode's free tier can only be used from within OpenCode."}}
// ```
//
// In other words it judges whether the caller is the official client by **payload
// shape**. Measured (2026-10-16): with the three items below in place it is a stable 200:
//
// | Requirement | Value |
// | --- | --- |
// | Headers | `x-opencode-project` (40 hex), `x-opencode-session` + `x-opencode-session-id` (`ses_` shape), `x-opencode-request` (`msg_` shape), `x-opencode-client: cli`, `User-Agent: opencode/<version>` |
// | Session id shape | `ses_` + **12 lowercase hex** (minted from a timestamp) + **14 base62**; mistaking it for a 26-char random segment gives 38 chars and **always 403** |
// | Request body | `stream: true`, and `tools` must contain the four function tools `bash` / `glob` / `grep` / `read`, each declaring at least one property in `parameters` |
//
// ## How the clash with the caller's tool names is resolved
//
// Claude Code has its own `Bash` / `Read` tools, but the gate wants those four names in
// **lowercase**, and it does not necessarily declare `glob` / `grep`. So two things
// happen here:
//
// - The caller declared a tool with the same name (case-insensitive) → rewrite it to
//   lowercase outbound and **restore the original name** in the response, or Claude Code
//   will not recognise `bash`;
// - The caller did not declare it → add a decoy stub and **drop** the model's calls to
//   it — that is a tool name Claude Code cannot execute, and forwarding it only produces
//   an error nobody can handle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bridgeHome, credentialFile } from "./home.js";
import { readStore, saveCredential } from "./auth.js";
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Gate tool names: the server recognises the official client shape by these four names. */
export const GATE_TOOLS = ['bash', 'glob', 'grep', 'read'];
export const OPENCODE = {
    id: 'oc',
    kind: 'openai',
    /** Anonymous free tier: needs no credential at all. */
    auth: 'none',
    label: 'OpenCode 免费模型',
    hint: '无需登录，走 opencode.ai 官方免费档',
    baseUrl: 'https://opencode.ai/inference',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    /** The anonymous credential is the literal `public` (the official CLI uses it when it has no key). */
    anonymousKey: 'public',
    defaultUserAgent: 'opencode/1.18.22',
    /** The most useful free-tier model for Claude Code: DeepSeek V4.1 Flash. */
    defaultModel: 'deepseek-v4.1-flash-free',
    /** Capability metadata source (the official CLI uses it too; `/v1/models` carries no capability fields). */
    modelsDevUrl: 'https://models.dev/api.json',
    modelsDevTtlMs: 60 * 60 * 1000,
};
/**
 * Capability table cache.
 *
 * ⚠️ This table **must** be consulted: `/v1/models` returns only id/object/created/
 * owned_by (all 88 entries), no capability information at all. Yet "how big is the
 * window" directly decides whether Claude Code gets the `[1m]` suffix — the free
 * tier's `deepseek-v4.1-flash-free` measures **200k** (not 1M), and a wrong suffix
 * makes it compact at 1M and then hit the model's real limit.
 */
let capabilityCache = { at: 0, byId: new Map() };
async function opencodeCapabilities({ signal } = {}) {
    const now = Date.now();
    const ttl = OPENCODE.modelsDevTtlMs ?? 0;
    if (now - capabilityCache.at < ttl && capabilityCache.byId.size > 0)
        return capabilityCache.byId;
    try {
        const response = await fetch(OPENCODE.modelsDevUrl ?? '', { signal: signal ?? AbortSignal.timeout(20_000) });
        if (!response.ok)
            return capabilityCache.byId;
        const payload = (await response.json());
        const opencode = payload.opencode;
        const models = opencode?.models;
        if (models === null || typeof models !== 'object')
            return capabilityCache.byId;
        const byId = new Map();
        for (const [id, entry] of Object.entries(models)) {
            const meta = (entry !== null && typeof entry === 'object' ? entry : {});
            const limit = (meta.limit !== null && typeof meta.limit === 'object' ? meta.limit : {});
            byId.set(id, {
                ...(typeof limit.context === 'number' ? { contextWindow: limit.context } : {}),
                ...(typeof limit.output === 'number' ? { maxOutputTokens: limit.output } : {}),
                ...(meta.attachment === true ? { supportsImages: true } : {}),
                ...(typeof meta.name === 'string' && meta.name !== '' ? { name: meta.name } : {}),
            });
        }
        capabilityCache = { at: now, byId };
    }
    catch {
        /* falling back to "no metadata", which is what keeps the [1m] suffix off */
    }
    return capabilityCache.byId;
}
/**
 * The Go plan (paid / subscription): **not the same path** as the free tier.
 *
 * Facts from measurement on 2026-10-16 (both key and endpoint were really exercised;
 * DSH desktop's `cordis.yml` uses the same set for `opencode-go`:
 * `apiKeyEnv: OPENCODE_GO_API_KEY`, `baseURL: https://opencode.ai/zen/go/v1`,
 * `headers: { x-opencode-session: <uuid> }`):
 *
 * | Fact | Evidence |
 * | --- | --- |
 * | Endpoint `/zen/go/v1` (the free tier is `/inference/v1`) | The two paths list different models: Go has 37 |
 * | `Authorization: Bearer oc_sk_…` is **required** | No header / a bogus key → 401 |
 * | `x-opencode-session` is **required** | Missing → `400 MissingSessionID`; either a UUID or the `ses_` shape is accepted |
 * | The free tier's shape gate is **not needed** | A bare OpenAI payload (no tools, none of the 5 headers) returns 200 |
 */
export const OPENCODE_GO = {
    id: 'ocg',
    kind: 'openai',
    auth: 'key',
    label: 'OpenCode Go 套餐',
    hint: '要 API key，走 /zen/go/v1',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    /** This path requires the session id; the value itself does not matter (it drives server-side routing affinity). */
    sessionHeader: 'x-opencode-session',
    defaultModel: 'deepseek-v4.1-flash',
};
/** The entry name in the credential store (shared with the two Tencent lines via credentials.json). */
const GO_ENTRY = 'opencode-go';
/** Read the Go plan credential; undefined when it is not configured. */
export function goCredential() {
    const entry = readStore(credentialFile())[GO_ENTRY];
    if (typeof entry?.apiKey !== 'string' || entry.apiKey === '')
        return undefined;
    return {
        apiKey: entry.apiKey,
        session: typeof entry.session === 'string' && entry.session !== '' ? entry.session : crypto.randomUUID(),
    };
}
export const hasGoCredential = () => goCredential() !== undefined;
/**
 * Store the Go plan key.
 *
 * The session id is generated once here and reused from disk: it only affects
 * server-side routing affinity, but a fresh one per run makes the same machine
 * look like many independent clients (DSH pins a single UUID for this reason).
 */
export function saveGoKey(apiKey, { file = credentialFile(), session } = {}) {
    const trimmed = String(apiKey ?? '').trim();
    if (trimmed === '')
        throw new Error('the key must not be empty');
    const existing = readStore(file)[GO_ENTRY];
    saveCredential({ id: GO_ENTRY }, {
        apiKey: trimmed,
        session: session ??
            (typeof existing?.session === 'string' && existing.session !== '' ? existing.session : crypto.randomUUID()),
        /** Display only: never persist the whole plaintext, just the last four characters. */
        tail: trimmed.slice(-4),
        savedAt: new Date().toISOString(),
    }, file);
    return goCredential();
}
/** For display: the last four characters of the configured key. */
export const goKeyTail = () => readStore(credentialFile())[GO_ENTRY]?.tail;
function randomBase62(length) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += BASE62[bytes[i] % BASE62.length];
    return out;
}
/** 12 lowercase hex characters minted from a timestamp, matching the official id module's `timeBytes`. */
function timeHex(value) {
    let hex = '';
    for (let i = 0; i < 6; i++)
        hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
            .toString(16)
            .padStart(2, '0');
    return hex;
}
let lastStamp = 0;
let sequence = 0;
/**
 * Mint a session id: `ses_` + 12 hex + **14** base62 characters.
 *
 * The tail's total length of 26 (12 + 14) comes from `LENGTH = 26` in the official
 * `id/index.ts`; the random part is `26 - 12 = 14`. Treating 26 as the random segment
 * length yields 38 characters and the gate answers 403.
 */
export function sessionId() {
    const stamp = Date.now();
    if (stamp !== lastStamp) {
        lastStamp = stamp;
        sequence = 0;
    }
    sequence += 1;
    return `ses_${timeHex(~(BigInt(stamp) * 0x1000n + BigInt(sequence)))}${randomBase62(14)}`;
}
/** The per-request request id, minted in the `msg_` shape the gateway also accepts. */
export function requestId() {
    return `msg_${timeHex(BigInt(Date.now()) * 0x1000n + 1n)}${randomBase62(14)}`;
}
/**
 * The project id: 40 lowercase hex characters, the same shape as the official CLI's
 * `sha1("git-remote:" + …)`.
 *
 * This machine's identity lives in `BRIDGE_HOME/opencode.json` and survives restarts —
 * a fresh one every time makes the same machine look like many independent clients
 * server-side.
 *
 * Memoised per data directory: this sits on the per-request path, and a
 * synchronous read there is paid by every concurrent turn. The value only
 * changes when the file is deleted, which no code path does.
 */
const projectIdCache = new Map();
export function projectId(home = bridgeHome()) {
    const cached = projectIdCache.get(home);
    if (cached !== undefined)
        return cached;
    const file = path.join(home, 'opencode.json');
    try {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof stored?.projectId === 'string' && /^[0-9a-f]{40}$/.test(stored.projectId)) {
            projectIdCache.set(home, stored.projectId);
            return stored.projectId;
        }
    }
    catch {
        /* first use */
    }
    const identity = crypto.randomBytes(16).toString('hex');
    const value = crypto.createHash('sha1').update(`git-remote:opencode/${identity}`).digest('hex');
    try {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ projectId: value }, null, 2), { mode: 0o600 });
    }
    catch {
        /* a failed write does not affect this request */
    }
    projectIdCache.set(home, value);
    return value;
}
/** Session id used by the anonymous tier, persisted next to the project id. */
export function persistedSession(home = bridgeHome()) {
    const file = path.join(home, 'opencode.json');
    try {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof stored?.session === 'string' && SESSION_SHAPE.test(stored.session))
            return stored.session;
    }
    catch {
        /* first use */
    }
    const value = sessionId();
    try {
        const stored = (() => {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
            catch {
                return {};
            }
        })();
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ ...stored, session: value }, null, 2), { mode: 0o600 });
    }
    catch {
        /* a failed write only costs affinity, not this request */
    }
    return value;
}
const SESSION_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/**
 * Header set sent to the free tier, mirroring the official client.
 *
 * `x-opencode-session-id` is **currently not mandatory** (measured 2026-10-16:
 * `fo doctor` re-deriving each requirement classified it as relaxed — dropping it
 * still yields 200), yet it is still sent: that keeps the shape identical to the
 * official client, so a future tightening needs no code change. Rules and evidence
 * live in `docs/gates.md`.
 */
export function shapeHeaders({ project, session, request, userAgent = OPENCODE.defaultUserAgent, }) {
    return {
        'x-opencode-project': project,
        'x-opencode-session': session,
        // The newer gate requires this alias header to match the session: the shape is
        // right but a missing alias still earns a 403.
        'x-opencode-session-id': session,
        'x-opencode-request': request,
        'x-opencode-client': 'cli',
        'user-agent': userAgent ?? OPENCODE.defaultUserAgent ?? '',
    };
}
function stubTool(name) {
    return {
        type: 'function',
        function: {
            name,
            description: 'Reserved for the host runtime; do not call it.',
            parameters: {
                type: 'object',
                properties: { input: { type: 'string', description: 'Unavailable; do not use.' } },
            },
        },
    };
}
/**
 * Wrap a request body in the shape the free tier requires.
 *
 * `rename` maps an outbound lowercase name back to the caller's original
 * (`bash` -> `Bash`); `stubs` holds names that exist only as stubs and must be
 * dropped from the response.
 */
export function applyFreeTierGate(body) {
    const tools = Array.isArray(body.tools) ? [...body.tools] : [];
    const rename = new Map();
    const declared = new Set();
    const rewritten = tools.map(tool => {
        const name = tool?.function?.name;
        if (typeof name !== 'string' || name === '')
            return tool;
        const lower = name.toLowerCase();
        if (!GATE_TOOLS.includes(lower))
            return tool;
        declared.add(lower);
        if (lower === name)
            return tool;
        rename.set(lower, name);
        return { ...tool, function: { ...tool.function, name: lower } };
    });
    const stubs = new Set();
    for (const gate of GATE_TOOLS) {
        if (declared.has(gate))
            continue;
        stubs.add(gate);
        rewritten.push(stubTool(gate));
    }
    return {
        body: { ...body, stream: true, tools: rewritten },
        rename,
        stubs,
    };
}
/**
 * Rewrite tool names in response chunks.
 *
 * - Names in `rename` are restored to the caller's original (`bash` -> `Bash`);
 *   Claude Code does not recognise the lowercase form.
 * - Names in `stubs` are dropped entirely: those are the stubs added to clear the
 *   gate, the caller has no such tool, and forwarding one only produces an
 *   "unknown tool" failure.
 */
export async function* restoreToolCalls(chunks, { rename, stubs }) {
    const dropped = new Set();
    for await (const chunk of chunks) {
        const record = (chunk !== null && typeof chunk === 'object' ? chunk : {});
        const choices = Array.isArray(record.choices) ? record.choices : undefined;
        if (choices === undefined) {
            yield chunk;
            continue;
        }
        let touched = false;
        const next = choices.map((choice) => {
            const delta = (choice.delta !== null && typeof choice.delta === 'object' ? choice.delta : {});
            const calls = delta.tool_calls;
            if (!Array.isArray(calls) || calls.length === 0)
                return choice;
            const kept = [];
            for (const call of calls) {
                const index = Number.isInteger(call?.index) ? call.index : 0;
                if (dropped.has(index)) {
                    touched = true;
                    continue;
                }
                const name = call?.function?.name;
                if (typeof name === 'string' && stubs.has(name.toLowerCase())) {
                    dropped.add(index);
                    touched = true;
                    continue;
                }
                const original = typeof name === 'string' ? rename.get(name.toLowerCase()) : undefined;
                if (original === undefined) {
                    kept.push(call);
                    continue;
                }
                touched = true;
                kept.push({ ...call, function: { ...call.function, name: original } });
            }
            return touched ? { ...choice, delta: { ...delta, tool_calls: kept.length === 0 ? [] : kept } } : choice;
        });
        yield touched ? { ...record, choices: next } : chunk;
    }
}
import { failureOf, readSse } from "./sse.js";
/**
 * Session id reused for the life of the process. The official CLI uses one id per
 * session; a fresh random one each time makes the same caller look like many
 * independent sessions, which breaks affinity rather than preserving it.
 */
let session = '';
/**
 * The model catalogue.
 *
 * The two paths differ only in authentication headers: the free tier uses the
 * anonymous `Bearer public`, the Go plan a real key plus a mandatory session
 * header. The catalogue itself only returns `id/object/created/owned_by`, so
 * capabilities are fetched separately from models.dev (see `opencodeCapabilities`).
 */
export async function listModels(source = OPENCODE, { signal } = {}) {
    const credential = source.auth === 'key' ? goCredential() : undefined;
    if (source.auth === 'key' && credential === undefined) {
        throw new Error(`${source.label}: no API key configured (set one in the menu, or use the free tier first)`);
    }
    const headers = credential === undefined
        ? { authorization: `Bearer ${source.anonymousKey ?? ''}`, 'user-agent': source.defaultUserAgent ?? '' }
        : {
            authorization: `Bearer ${credential.apiKey ?? ''}`,
            [source.sessionHeader ?? 'x-opencode-session']: credential.session ?? '',
        };
    const response = await fetch(`${source.baseUrl}${source.modelsPath}`, {
        headers,
        signal: signal === undefined ? AbortSignal.timeout(20_000) : signal,
    });
    if (!response.ok) {
        const failure = await failureOf(response);
        throw new Error(`OpenCode model catalogue failed: ${failure.message}`);
    }
    const payload = (await response.json());
    const capabilities = await opencodeCapabilities({ signal });
    return (Array.isArray(payload.data) ? payload.data : [])
        .filter(row => typeof row?.id === 'string' && row.id !== '')
        .map(row => {
        const id = row.id;
        return {
            id,
            name: id,
            // IDs ending in `-free` are the official free tier; the rest need an OpenCode
            // Go subscription (from $10/month).
            free: id.endsWith('-free') || id === 'big-pickle',
            ...(capabilities.get(id) ?? {}),
        };
    });
}
/**
 * Send one free-tier conversation.
 *
 * The return shape matches the gateway upstream — `{ok:true, chunks}` or
 * `{ok:false, status, message}` — so the Anthropic translation layer never has to
 * know which upstream answered.
 */
export async function chat(source, model, body, { signal, log = () => { } } = {}) {
    // Go plan (authenticated channel): only a key and the session header, **without**
    // the free tier's shape gate (measured: a bare OpenAI payload returns 200), so no
    // tool renaming or stubbing happens here.
    if (source.auth === 'key') {
        const credential = goCredential();
        if (credential === undefined)
            return { ok: false, status: 401, message: `${source.label}: no API key configured` };
        const response = await fetch(`${source.baseUrl}${source.chatPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${credential.apiKey}`,
                'content-type': 'application/json',
                accept: 'text/event-stream',
                [source.sessionHeader ?? 'x-opencode-session']: credential.session ?? '',
            },
            body: JSON.stringify({ ...body, model, stream: true }),
            signal,
        });
        if (!response.ok) {
            const failure = await failureOf(response);
            if (/MissingSessionID/i.test(failure.message)) {
                log(`${source.label}: the upstream requires session header ${source.sessionHeader} (sent automatically; file an issue if this appears)`);
            }
            return failure;
        }
        log(`${source.label}: turn established for ${model} (session ${String(credential.session).slice(0, 8)}…)`);
        return { ok: true, chunks: readSse(asReadableStream(response.body), true) };
    }
    // Persisted, not per-process: a restart used to mint a new session id and with it a
    // new affinity bucket, for the same reason `projectId` is persisted.
    if (session === '')
        session = persistedSession();
    const gated = applyFreeTierGate({ ...body, model });
    const response = await fetch(`${source.baseUrl}${source.chatPath}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${source.anonymousKey ?? ''}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...shapeHeaders({ project: projectId(), session, request: requestId() }),
        },
        body: JSON.stringify(gated.body),
        signal,
    });
    if (!response.ok) {
        const failure = await failureOf(response);
        // FreeTierError only says the shape was not recognised; saying so beats letting
        // the user guess.
        if (/free tier can only be used/i.test(failure.message)) {
            log(`${source.label}: rejected by the free-tier gate (payload shape not recognised); file an issue with your version`);
        }
        return failure;
    }
    log(`${source.label}: turn established for ${model} (session ${session.slice(0, 12)}…)`);
    return { ok: true, chunks: restoreToolCalls(readSse(asReadableStream(response.body), true), gated) };
}
/** `fetch` types the body as nullable; a 2xx SSE response always has one. */
function asReadableStream(body) {
    if (body === null)
        throw new Error('the upstream returned a 2xx response without a body');
    return body;
}
/** For tests and diagnostics: the session id this process is using. */
export const currentSession = () => session;
