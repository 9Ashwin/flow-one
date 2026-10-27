// The Tencent product client: model catalogue and conversation.
//
// The identity headers on these two requests are the official client's outbound shape;
// missing one gets the request attributed as `-` server-side or rejected outright, so
// they are built in one place:
//
// ```
// Control plane: X-Domain / X-Product: SaaS / X-Product-Code / User-Agent / Authorization
// Chat plane: all of the above + X-Agent-Purpose: conversation + X-IDE-Name/Type/Version
// ```
//
// Two easy traps, with their sources noted in the code:
// - **`messages[0]` must be system**. The international gateway answers `400 + code
//   11128` to a request whose first message is `user`, so a system message is always
//   prepended here, not only when the client supplied one.
// - **`stream` is always true**. This upstream has no non-streaming chat endpoint;
//   `stream:false` is not "return it in one go" but a failure.
import crypto from 'node:crypto';
import { ensureCredential } from "./auth.js";
import { userAgentFor } from "./products.js";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SYSTEM = 'You are a helpful assistant.';
const ENTERPRISE_SCOPE = 'personal';
const PREFERRED_AGENTS = ['cli', 'craft'];
/**
 * Conversation identity headers.
 *
 * ⚠️ Since 2026-10-21 the international edition checks **conversation identity** on
 * `/v2/chat/completions`: without `X-Conversation-ID` / `X-Conversation-Request-ID` /
 * `X-Conversation-Message-ID` it answers `400 + code 11128`, saying "this call failed
 * the channel check; it may not have come from an official client" — and it blocks
 * even when none of the three Anthropic literals are in system (this is not content
 * moderation).
 *
 * Two pieces of evidence: the `app.asar` of official client `WorkBuddy AI 5.7.6`
 * (`Yr()` in `main/daemon-bootstrap.js` sets all three headers every time); then
 * removing them one by one — dropping only `X-Request-ID` / `x-codebuddy-request` /
 * `X-Agent-Intent` / `X-Private-Data` / `acp-connection-id` / `x-requested-with` still
 * yields 200, and the values need not be UUIDs. `cn/` does not check this set, and
 * sending them is harmless.
 *
 * The conversation id is fixed per process (one long session); request and message ids
 * are minted per request — the same shape as the official client.
 */
const CONVERSATION_ID = crypto.randomUUID();
function conversationHeaders() {
    return {
        'X-Conversation-ID': CONVERSATION_ID,
        'X-Conversation-Request-ID': crypto.randomUUID(),
        'X-Conversation-Message-ID': crypto.randomUUID(),
    };
}
function headersFor(product, credential, model) {
    const headers = {
        'X-Domain': product.apiDomain,
        'X-Product': 'SaaS',
        'X-Product-Code': product.productCode,
        'User-Agent': model === undefined ? product.userAgent : userAgentFor(product, model),
        Authorization: `Bearer ${credential.accessToken ?? ''}`,
    };
    const enterpriseId = credential.account?.enterpriseId ?? '';
    if (enterpriseId !== '') {
        headers['X-Enterprise-Id'] = enterpriseId;
        headers['X-Tenant-Id'] = enterpriseId;
    }
    return headers;
}
async function getJson(url, headers, signal) {
    const response = await fetch(url, {
        headers,
        signal: signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : signal,
    });
    let body = null;
    try {
        body = await response.json();
    }
    catch {
        /* a body-less response is left to the status code */
    }
    return { status: response.status, body };
}
function isAutoAlias(id) {
    return id === 'auto' || id === 'default';
}
/** Completion / NES / text-to-image entries are not chat models; listing them makes users pick one that always fails. */
function isChatModel(id, meta) {
    if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-'))
        return false;
    if (meta?.supportsExtra === true)
        return false;
    const maxOutput = meta?.maxOutputTokens;
    if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256)
        return false;
    if (Array.isArray(meta?.tags) && meta.tags.includes('text-to-image'))
        return false;
    return true;
}
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Land the requested level on one the model really supports.
 *
 * An empty `efforts` means the model declares no levels: pass it through unchanged (the
 * upstream normalises to the nearest one) instead of guessing for it. On a tie prefer
 * the **lower** level: asking a low/high model for medium, low is closer to the intent
 * than high.
 */
export function nearestEffort(wanted, efforts) {
    if (!Array.isArray(efforts) || efforts.length === 0)
        return wanted;
    if (efforts.includes(wanted))
        return wanted;
    const target = EFFORT_ORDER.indexOf(wanted);
    if (target === -1)
        return efforts[0];
    let best = efforts[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const effort of efforts) {
        const at = EFFORT_ORDER.indexOf(effort);
        if (at === -1)
            continue;
        const distance = Math.abs(at - target);
        if (distance < bestDistance || (distance === bestDistance && at < EFFORT_ORDER.indexOf(best))) {
            best = effort;
            bestDistance = distance;
        }
    }
    return best;
}
function metaOf(record) {
    if (record === null || typeof record !== 'object')
        return {};
    const source = record;
    const meta = {};
    if (typeof source.maxInputTokens === 'number' && source.maxInputTokens > 0)
        meta.contextWindow = source.maxInputTokens;
    if (typeof source.maxOutputTokens === 'number' && source.maxOutputTokens > 0)
        meta.maxOutputTokens = source.maxOutputTokens;
    if (typeof source.supportsImages === 'boolean')
        meta.supportsImages = source.supportsImages;
    if (source.supportsExtra === true)
        meta.supportsExtra = true;
    if (Array.isArray(source.tags))
        meta.tags = source.tags.filter((item) => typeof item === 'string');
    const reasoning = source.reasoning;
    if (reasoning !== null && typeof reasoning === 'object') {
        const detail = reasoning;
        if (Array.isArray(detail.supportedEfforts)) {
            const efforts = detail.supportedEfforts.filter((item) => typeof item === 'string' && item !== '');
            if (efforts.length > 0)
                meta.efforts = efforts;
        }
        if (typeof detail.defaultEffort === 'string' && detail.defaultEffort !== '')
            meta.defaultEffort = detail.defaultEffort;
    }
    return meta;
}
/** Trial-banner models appear in neither the agent list nor `data.models`, but they are callable. */
function trialModelIds(data) {
    const config = data.productFeaturesConfig;
    const banner = config?.ModelTrialBanner;
    const banners = banner?.banners;
    if (!Array.isArray(banners))
        return [];
    return banners
        .map(item => item !== null && typeof item === 'object' ? item.targetModelId : undefined)
        .filter((id) => typeof id === 'string' && id !== '');
}
/**
 * Parse the `/v3/config` and enterprise model responses.
 *
 * Order is priority: models the main chat agent (`cli` or `craft`) references come
 * first, then the rest of the chat models in `data.models`, then trial-banner
 * entries. The two endpoints expose **different** sets (measured: the China
 * edition's `hy4-preview-f` only appears in `/v3/config`), so callers merge them.
 */
export function parseModels(body) {
    const payload = body !== null && typeof body === 'object' ? body.data : undefined;
    if (payload === null || typeof payload !== 'object')
        return [];
    const data = payload;
    const metaById = new Map();
    if (Array.isArray(data.models)) {
        for (const model of data.models) {
            if (model !== null && typeof model === 'object' && typeof model.id === 'string') {
                metaById.set(model.id, model);
            }
        }
    }
    const parsed = [];
    const seen = new Set();
    const push = (id) => {
        if (typeof id !== 'string' || id === '' || isAutoAlias(id) || seen.has(id))
            return;
        const meta = metaById.get(id);
        if (!isChatModel(id, meta === undefined ? undefined : metaOf(meta)))
            return;
        seen.add(id);
        const name = typeof meta?.name === 'string' && meta.name !== '' ? meta.name : id;
        parsed.push({ id, name, ...metaOf(meta) });
    };
    const agents = Array.isArray(data.agents) ? data.agents : [];
    for (const agentName of PREFERRED_AGENTS) {
        const agent = agents.find(item => item !== null && typeof item === 'object' && item.name === agentName);
        if (agent === undefined)
            continue;
        for (const id of Array.isArray(agent.models) ? agent.models : [])
            push(id);
        break;
    }
    for (const id of metaById.keys())
        push(id);
    for (const id of trialModelIds(data))
        push(id);
    return parsed;
}
/**
 * Fetch the model catalogue: the enterprise endpoint (richest metadata) first,
 * falling back to `/v3/config` when it is empty or fails, and only using the
 * product's static list when both are unavailable.
 */
export async function listModels(product, credential, { signal, log = () => { } } = {}) {
    const headers = headersFor(product, credential);
    const scoped = await getJson(`${product.endpoint}/console/enterprises/${ENTERPRISE_SCOPE}/models`, headers, signal)
        .then(result => (result.status === 200 ? parseModels(result.body) : []))
        .catch(() => []);
    const config = await getJson(`${product.endpoint}/v3/config`, headers, signal)
        .then(result => (result.status === 200 ? parseModels(result.body) : []))
        .catch(() => []);
    const merged = [...scoped];
    const known = new Set(scoped.map(model => model.id));
    for (const model of config)
        if (!known.has(model.id))
            merged.push(model);
    if (merged.length === 0) {
        log(`${product.label}: the remote catalogue is empty, using the built-in fallback list`);
        return product.fallbackModels.map(id => ({ id, name: id }));
    }
    return merged;
}
/**
 * The human-readable reason an upstream failure carries.
 *
 * The two upstreams fail with **different shapes**; recognising only one throws away
 * the other's reason:
 *
 * - Moderation / channel check: `{code:11128, msg:'request illegal', displayMsg:{zh,en}, displayTips:{zh,en}}`
 * - Quota / rate limit: `{error:{data:{code:14018, msg:'Credits exhausted…'}}}`
 *
 * `msg` is often just an uninformative `request illegal`; what actually helps is
 * `displayMsg` / `displayTips` ("this call failed the channel check…") plus `code` —
 * `fo doctor` uses the code to tell "blocked by moderation" from "quota limited", and
 * getting that wrong sends people to read the rules when all they need is another route
 * or to wait for quota.
 */
export function failureDetail(raw) {
    const rawText = String(raw ?? '');
    if (rawText === '')
        return '';
    let payload;
    try {
        payload = JSON.parse(rawText);
    }
    catch {
        return rawText.slice(0, 300);
    }
    const parsed = payload !== null && typeof payload === 'object' ? payload : {};
    const errorField = parsed.error !== null && typeof parsed.error === 'object' ? parsed.error : undefined;
    const data = (errorField?.data ?? parsed);
    const code = typeof data.code === 'number' ? data.code : undefined;
    const localized = localizedText(data.displayMsg) ?? localizedText(data.displayTips);
    const tips = localizedText(data.displayTips);
    const primary = [localized, tips].filter((item) => typeof item === 'string' && item !== '').join(' / ') ||
        asNonEmptyString(data.msg) ||
        asNonEmptyString(data.message) ||
        asNonEmptyString(errorField?.message) ||
        '';
    const parts = [];
    if (code !== undefined)
        parts.push(`upstream ${code}`);
    if (primary !== '')
        parts.push(primary);
    return parts.length === 0 ? rawText.slice(0, 300) : parts.join(': ');
}
/** `displayMsg` / `displayTips` arrive as `{ zh, en }`; prefer Chinese, fall back to English. */
function localizedText(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    return asNonEmptyString(record.zh) ?? asNonEmptyString(record.en);
}
function asNonEmptyString(value) {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** Prefix cache key: a stable system prefix hits consistently; measured ~17x billing difference on the same request. */
export function cacheKeyFor(messages, model) {
    const system = messages.find(message => message.role === 'system');
    const seed = `${model}\u0000${typeof system?.content === 'string' ? system.content : ''}`;
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
/**
 * Rewrite the bridge's internal OpenAI body into the shape this upstream really
 * accepts.
 *
 * Fields known to be unusable are **dropped** here rather than forwarded: the
 * official client never sends `tool_choice` or `top_p`, and forwarding an
 * unverified parameter only earns a 400.
 */
export function toBuddyBody(openAiBody, { meta, model }) {
    const messages = Array.isArray(openAiBody.messages) ? [...openAiBody.messages] : [];
    // The International gateway answers 400 + 11128 to a request whose first message is not `system`.
    if (messages.length === 0 || messages[0].role !== 'system') {
        messages.unshift({ role: 'system', content: DEFAULT_SYSTEM });
    }
    const body = {
        model,
        messages,
        stream: true,
        prompt_cache_key: cacheKeyFor(messages, model),
    };
    if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0)
        body.tools = openAiBody.tools;
    if (typeof openAiBody.temperature === 'number')
        body.temperature = openAiBody.temperature;
    if (Array.isArray(openAiBody.stop) && openAiBody.stop.length > 0)
        body.stop = openAiBody.stop;
    const efforts = Array.isArray(meta?.efforts) ? meta.efforts : [];
    const cap = typeof meta?.maxOutputTokens === 'number' && meta.maxOutputTokens > 0 ? meta.maxOutputTokens : 0;
    const requested = Number(openAiBody.max_tokens);
    if (Number.isFinite(requested) && requested > 0)
        body.max_tokens = cap > 0 ? Math.min(Math.trunc(requested), cap) : Math.trunc(requested);
    else if (cap > 0)
        body.max_tokens = cap;
    const deepseek = /deepseek/i.test(model);
    const wanted = typeof openAiBody.reasoning_effort === 'string' ? openAiBody.reasoning_effort : undefined;
    if (wanted !== undefined) {
        // The level the client asks for is not necessarily in the model's table (DSH's
        // medium 8192 landing on a model that only declares low/high/max, for example).
        // This used to be **dropped silently**, so the deepseek family fell back to its
        // default high — the user picked medium and got high (found 2026-10-22 while
        // aligning the DSH budget table). Normalise to the nearest supported level.
        const picked = nearestEffort(wanted, efforts);
        if (picked !== undefined)
            body.reasoning_effort = picked;
    }
    if (deepseek) {
        // Measured: for this family only `reasoning_effort` enables thinking; `thinking`
        // alone has no effect, and both are needed to reliably get `reasoning_content`.
        body.thinking = { type: 'enabled' };
        if (body.reasoning_effort === undefined && efforts.length > 0) {
            body.reasoning_effort =
                meta?.defaultEffort && efforts.includes(meta.defaultEffort)
                    ? meta.defaultEffort
                    : efforts.includes('high')
                        ? 'high'
                        : efforts[0];
        }
    }
    return body;
}
/**
 * Send one conversation request.
 *
 * On 401/403 the token is renewed silently with the refresh token and the request
 * is **retried once**: expiry during a long session is normal, and losing a turn
 * over it is not acceptable.
 */
export async function chat(product, openAiBody, { model, meta, signal, log = () => { }, file, }) {
    const wire = toBuddyBody(openAiBody, { meta, model });
    let credential = await ensureCredential(product, { log, signal, file });
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${product.endpoint}/v2/chat/completions`, {
            method: 'POST',
            headers: {
                ...headersFor(product, credential, model),
                ...conversationHeaders(),
                Accept: 'text/event-stream',
                'Content-Type': 'application/json',
                'X-Agent-Purpose': 'conversation',
                'X-IDE-Name': product.attributionName,
                'X-IDE-Type': product.attributionName,
                'X-IDE-Version': product.clientVersion,
            },
            body: JSON.stringify(wire),
            signal: signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : signal,
        });
        if (response.ok)
            return { ok: true, response };
        let detail = '';
        try {
            detail = failureDetail(await response.text());
        }
        catch {
            /* an unreadable body leaves the status code as the only signal */
        }
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
            log(`${product.label}: token rejected (HTTP ${response.status}), renewing and retrying`);
            credential = await ensureCredential(product, { log, signal, file, force: true });
            continue;
        }
        const retryAfter = response.headers.get('retry-after');
        return {
            ok: false,
            status: response.status,
            message: detail === '' ? `upstream returned ${response.status}` : detail,
            ...(retryAfter === null ? {} : { retryAfter }),
        };
    }
    return { ok: false, status: 401, message: `${product.label}: login expired; run login ${product.id} again` };
}
