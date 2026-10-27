// Self-check: turn the **facts** behind the two gates into executable verification rather
// than leaving them in documentation.
//
// This project's functional core rests on two other people's rules, and either can change
// overnight:
//
// 1. **The OpenCode free tier's payload-shape gate** (5 headers / the `ses_` shape /
//    `stream:true` + four lowercase tools) — when the upstream tightens it, the symptom is
//    `FreeTierError`;
// 2. **Tencent's content-filter literals** (the whole `x-anthropic-billing-header` line, the
//    identity sentence, the gitStatus main-branch sentence) — the symptom is
//    `400 + code 11128`.
//
// So this is not "hit /health and see if it is alive", but **actively re-deriving the gate**:
// send one complete shape to prove it passes, then drop one requirement at a time and prove
// it **really is still required**. That way, when the upstream changes, the user can see
// which rule broke instead of only "International is unusable".
import { OPENCODE, OPENCODE_GO, applyFreeTierGate, goCredential, goKeyTail, projectId, requestId, sessionId, shapeHeaders, } from "./opencode.js";
import { SOURCES, needsLogin } from "./sources.js";
import { hasGoCredential } from "./opencode.js";
import { credentialStatus, ensureCredential } from "./auth.js";
import { chat as buddyChat, listModels } from "./buddy.js";
import { toOpenAiRequest } from "./anthropic.js";
import { systemRewriterFor } from "./fingerprint.js";
import { LEGACY_SERVICE_LABEL, claudeSettingsPath, currentCliPath, readInstallState, serviceCliPath, serviceState, } from "./install.js";
import { HOME_DIR, LEGACY_HOME_DIR, legacyHomeInUse } from "./home.js";
import fs from 'node:fs';
/** Error text the way the probes print it: `message` for an Error, `String(...)` otherwise. */
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
const gateStub = (name) => ({
    type: 'function',
    function: {
        name,
        description: 'Reserved for the host runtime; do not call it.',
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'Unavailable; do not use.' } } },
    },
});
/**
 * A deliberately wrong version of the session shape: **the tail is written as 26 random
 * characters** (38 total).
 *
 * This is exactly the trap the docs warn about — `LENGTH = 26` in the official
 * `id/index.ts` is the tail's total length (12 hex + 14 base62); taking it as the length of
 * the random part adds 12 extra characters.
 *
 * ⚠️ Do not use `ses_` + 26 `0`s as the counter-example: `0` is both hex and base62, so that
 * string **has the right shape** and neither a fake gate nor the real upstream rejects it.
 */
const wrongSessionShape = () => `ses_${'0'.repeat(12)}${'A'.repeat(26)}`;
async function probeOnce(fetchImpl, baseUrl, body, headers, timeoutMs, anonymousKey) {
    try {
        const response = await fetchImpl(`${baseUrl}${OPENCODE.chatPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${anonymousKey}`,
                'content-type': 'application/json',
                accept: 'text/event-stream',
                ...headers,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        // Always drain the body (so no socket is left hanging), and recognise the error type on
        // **both paths**: the upstream occasionally answers 200 with an error envelope, and
        // looking only at the status code would count that as a pass.
        const text = await response.text();
        const errorType = /"(FreeTierError|AuthError|GoUsageLimitError|UsageLimitError)"/.exec(text)?.[1];
        if (response.ok && errorType === undefined)
            return { status: response.status, errorType: undefined, ok: true };
        return { status: response.status, errorType, ok: false, message: text.slice(0, 200) };
    }
    catch (error) {
        return { status: 0, errorType: undefined, ok: false, message: errorText(error) };
    }
}
/**
 * The upstream says "403 + FreeTierError" when it does not recognise the payload shape; both
 * phrasings have been seen in the wild, so both signals count.
 */
const gateRejected = (result) => result.errorType === 'FreeTierError' || /free tier can only be used/i.test(result.message ?? '');
/**
 * Re-derive the OpenCode free tier gate.
 *
 * The complete shape should get 200; the four "one requirement removed" variants should be
 * rejected. A variant that is **not rejected** means that requirement is no longer mandatory
 * (the upstream relaxed it); a rejected complete shape means the upstream tightened it.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] defaults to `OPENCODE.baseUrl`; tests inject a localhost
 *   address
 * @param {Function} [options.fetchImpl] defaults to the global `fetch`; tests inject a fake
 *   (offline)
 * @param {string} [options.anonymousKey] defaults to `OPENCODE.anonymousKey` (the anonymous
 *   tier's literal `public`)
 */
export async function probeOpencodeGate({ baseUrl = OPENCODE.baseUrl ?? '', fetchImpl = fetch, timeoutMs = 20_000, anonymousKey = OPENCODE.anonymousKey ?? '', } = {}) {
    const base = {
        model: OPENCODE.defaultModel,
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
    };
    const full = applyFreeTierGate({
        ...base,
        tools: ['bash', 'glob', 'grep', 'read'].map(gateStub),
    });
    const project = projectId();
    const session = sessionId();
    const headers = shapeHeaders({ project, session, request: requestId() });
    const rows = [];
    const complete = await probeOnce(fetchImpl, baseUrl, full.body, headers, timeoutMs, anonymousKey);
    // Four outcomes: should pass and did → pass; rejected by the gate (upstream tightened) →
    // fail; 429 / cannot connect → this round cannot decide
    const tightened = gateRejected(complete);
    rows.push({
        label: 'complete shape (5 headers + session shape + four tools + stream)',
        required: true,
        verdict: complete.ok ? 'pass' : tightened ? 'fail' : 'inconclusive',
        ...complete,
    });
    if (!complete.ok) {
        // Only an explicit FreeTierError counts as "the upstream tightened"; rate limiting and a
        // dead network are something else, and conflating them sends people the wrong way.
        return { baseUrl, rows, tightened, inconclusive: !tightened };
    }
    const { 'x-opencode-session-id': _omitted, ...withoutAlias } = headers;
    const variants = [
        { label: 'drop x-opencode-session-id', body: full.body, headers: withoutAlias },
        {
            label: 'session id tail written as 26 characters (38 total)',
            body: full.body,
            headers: { ...headers, 'x-opencode-session': wrongSessionShape(), 'x-opencode-session-id': wrongSessionShape() },
        },
        { label: 'tools without bash/glob/grep/read', body: { ...base }, headers },
        { label: 'stream: false', body: { ...full.body, stream: false }, headers },
    ];
    for (const variant of variants) {
        const result = await probeOnce(fetchImpl, baseUrl, variant.body, variant.headers, timeoutMs, anonymousKey);
        rows.push({
            label: variant.label,
            // Should be rejected but was let through ⇒ relaxed: this requirement is no longer
            // mandatory (the upstream loosened it; harmless in use, but the docs must follow)
            // Rejected ⇒ pass: this requirement really is mandatory, the fact still holds
            verdict: result.ok ? 'relaxed' : gateRejected(result) ? 'pass' : 'inconclusive',
            ...result,
        });
    }
    return {
        baseUrl,
        rows,
        tightened: false,
        relaxed: rows.filter(row => row.verdict === 'relaxed').map(row => row.label),
    };
}
/**
 * Re-derive three facts about the Go plan (the authenticated channel): the catalogue needs a
 * key, the session header is required, and with the session header it produces output.
 *
 * Unlike the free-tier path there is **no** shape gate here, so the probe is shorter: a
 * missing session header should yield `400 MissingSessionID`, not a FreeTierError.
 */
export async function probeOpencodeGo(source = OPENCODE_GO, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    const credential = goCredential();
    if (credential === undefined)
        return { configured: false, rows: [] };
    const rows = [];
    const url = `${source.baseUrl}${source.chatPath}`;
    const body = {
        model: source.defaultModel,
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
    };
    const call = async (headers) => {
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await response.text();
            return { status: response.status, ok: response.ok, message: response.ok ? '' : text.slice(0, 160) };
        }
        catch (error) {
            return { status: 0, ok: false, message: errorText(error) };
        }
    };
    const auth = { authorization: `Bearer ${credential.apiKey}` };
    // Three verdicts, never report "cannot decide" as "this path is broken":
    //   pass         output was produced
    //   fail         session header missing (a required-fact overturned) or credentials
    //                rejected — both are real problems
    //   inconclusive rate limited / upstream 5xx / cannot connect — unrelated to the gate, do
    //                not send people to inspect the session header
    const verdictOf = (result, failPattern) => {
        if (result.ok)
            return 'pass';
        if (failPattern.test(result.message ?? ''))
            return 'fail';
        if (result.status === 0 || result.status === 429 || result.status >= 500)
            return 'inconclusive';
        return 'fail';
    };
    const withSession = await call({ ...auth, [source.sessionHeader]: credential.session });
    rows.push({
        label: `minimal chat with ${source.sessionHeader}`,
        verdict: verdictOf(withSession, /MissingSessionID/),
        ...withSession,
    });
    const withoutSession = await call(auth);
    rows.push({
        label: `should be rejected without ${source.sessionHeader}`,
        verdict: !withoutSession.ok && /MissingSessionID/.test(withoutSession.message ?? '')
            ? 'pass'
            : withoutSession.ok
                ? 'relaxed'
                : 'inconclusive',
        ...withoutSession,
    });
    const listing = await (async () => {
        try {
            const response = await fetchImpl(`${source.baseUrl}${source.modelsPath}`, {
                headers: auth,
                signal: AbortSignal.timeout(timeoutMs),
            });
            const payload = response.ok && response.json !== undefined ? (await response.json()) : null;
            return { status: response.status, ok: response.ok, count: Array.isArray(payload?.data) ? payload.data.length : 0 };
        }
        catch (error) {
            return { status: 0, ok: false, message: errorText(error) };
        }
    })();
    rows.push({
        label: 'catalogue requires a key',
        verdict: verdictOf(listing, /Unauthorized|Forbidden|invalid/i),
        ...listing,
    });
    return { configured: true, tail: goKeyTail(), rows };
}
/**
 * The three known literal signals, joined into one minimal request: the rewriter should
 * remove them all.
 */
const FINGERPRINT_PAYLOAD = [
    "You are Claude Code, Anthropic's official CLI for Claude",
    'Main branch (you will usually use this for PRs): main',
    'x-anthropic-billing-header: cc_version=2.1.301',
].join('\n');
export async function probeTencentFingerprint(product, { log = () => { }, signal, credential, models, chat = buddyChat } = {}) {
    let cred = credential;
    if (cred === undefined) {
        try {
            // Bound first so the `signal` passthrough is not rejected as an excess property
            // while the credential helper's own option type is still being narrowed.
            const credentialOptions = { log, signal };
            cred = await ensureCredential(product, credentialOptions);
        }
        catch (error) {
            // Not being logged in is not a gate problem: skip this section and say so, rather than
            // letting the whole self-check fail along with it
            return {
                ok: false,
                verdict: 'inconclusive',
                skipped: true,
                status: 0,
                message: `${product.label} is not logged in, skipped (${errorText(error)})`,
            };
        }
    }
    const listOptions = { log, signal };
    const list = models ?? (await listModels(product, cred, listOptions));
    const meta = list.find((model) => model.id.includes('deepseek-v4.1-flash')) ?? list[0];
    if (meta === undefined)
        return { ok: false, verdict: 'inconclusive', status: 0, message: 'the catalogue is empty, cannot probe' };
    const request = {
        model: meta.id,
        max_tokens: 8,
        stream: true,
        system: FINGERPRINT_PAYLOAD,
        messages: [{ role: 'user', content: 'ping' }],
    };
    // The rewriter is selected by the **source-prefixed** model ID (`cn/…` / `intl/…`);
    // `meta.id` is the bare ID from the upstream catalogue, and asking with it always returns
    // undefined — which made the probe send the three literals verbatim, collide with 11128
    // every time, and get reported as "the filter rules stopped working" while the real chain
    // (prefixed model) was fine.
    const prefixed = `${product.id}/${meta.id}`;
    const translation = toOpenAiRequest(request, { model: meta.id, rewriteSystem: systemRewriterFor(prefixed, true) });
    if (translation.error !== undefined)
        return { ok: false, verdict: 'inconclusive', status: 0, message: `translation layer failed: ${translation.error}` };
    const result = await chat(product, translation.body, { model: meta.id, meta, signal, log });
    if (result.ok) {
        // `ok: true` always carries the response (buddy.chat contract); the loose probe
        // signature makes it optional, hence the assertion.
        const response = result.response;
        const text = await response.text();
        const status = response.status;
        const { blocked, limited } = classifyTencentFailure(text);
        // An in-stream block is "HTTP 200 + one {code,msg} frame": the status looks fine but not
        // a single character of content came out
        if (blocked)
            return { ok: false, verdict: 'fail', status, message: text.slice(0, 200), blocked, limited };
        if (limited)
            return { ok: false, verdict: 'inconclusive', status, message: text.slice(0, 200), blocked, limited };
        return { ok: true, verdict: 'pass', status, message: text.slice(0, 120) };
    }
    const message = result.message ?? '';
    const { blocked, limited } = classifyTencentFailure(message);
    // When quota/rate limited **this round never exercised the rewriter at all**: reporting it
    // as "the fingerprint rules stopped working" sends people to dig through the rules when all
    // they have to do is wait for the quota to recover.
    return {
        ok: false,
        verdict: blocked ? 'fail' : 'inconclusive',
        status: result.status,
        message: message.slice(0, 200),
        blocked,
        limited,
    };
}
/**
 * Split an upstream failure reason into "blocked by the content filter" and "quota / rate
 * limited".
 *
 * The two must stay apart: when quota limited, **this round never exercised the rewriter at
 * all**, and reporting that as "the fingerprint rules stopped working" points people in
 * exactly the wrong direction (digging through rules when all they need is to wait for the
 * quota to recover).
 */
export function classifyTencentFailure(message) {
    const text = String(message ?? '');
    // "channel verification" is 11128's newer wording (measured 2026-10-21: `request illegal` +
    // displayTips "this call did not pass channel verification"); it still counts as a filter
    // block. The Chinese literals stay in the pattern because they are upstream wire text.
    const blocked = /Illegal API invocation|unapproved channel|渠道校验|11128|请求被拦截/i.test(text);
    // `14018 Credits exhausted` is the International edition running out of quota: it must be
    // reported apart from the filter, or people get sent to inspect the rules. The Chinese
    // keywords are upstream wire text (Tencent's own messages), so they are matched as-is.
    const limited = !blocked && /频率限制|额度|超出|quota|rate limit|too many|Credits exhausted|14018/i.test(text);
    return { blocked, limited };
}
/**
 * Self-consistency check of the local configuration.
 *
 * A pure function (fed the settings / service environment / service file contents) so it can
 * be asserted offline — every one of these is a trap hit on a real machine: a key that
 * disagrees with the service yields 401, a `model` that disagrees with `ANTHROPIC_MODEL`
 * silently runs another model, a service pointing at the global install snapshot makes
 * `git pull` ineffective.
 */
export function localIssues({ settings, serviceEnv, serviceCli, runningCli, healthOk, service, legacyHome, }) {
    const issues = [];
    const env = settings?.env ?? {};
    const ok = [];
    // Two states left behind by the rename (claude-code-openai-bridge → flow-one); both have to
    // say what to do about them. "The old service still runs, the new one is not installed" is
    // especially easy to misread as "no service installed yet it works".
    if (service?.legacyInstalled === true && service?.installed !== true) {
        issues.push({
            level: 'warn',
            text: `the pre-rename service ${LEGACY_SERVICE_LABEL} is still installed (holding the port; the new one is not)`,
            fix: 'running setup once installs the new name and clears the old service; to remove only the old one: fo uninstall',
        });
    }
    if (legacyHome === true) {
        issues.push({
            level: 'warn',
            text: `the data directory is still the pre-rename ~/${LEGACY_HOME_DIR} (usable; the login state lives there)`,
            fix: `to move it to the new name: mv ~/${LEGACY_HOME_DIR} ~/${HOME_DIR}`,
        });
    }
    if (typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL !== '')
        ok.push(`BASE_URL ${env.ANTHROPIC_BASE_URL}`);
    else
        issues.push({
            level: 'fail',
            text: 'settings.json has no ANTHROPIC_BASE_URL — Claude Code will not use this bridge',
            fix: 'run setup to rewrite it',
        });
    if (serviceEnv?.BRIDGE_API_KEY !== undefined && env.ANTHROPIC_AUTH_TOKEN !== serviceEnv.BRIDGE_API_KEY) {
        issues.push({
            level: 'fail',
            text: "settings.json's key does not match the service's BRIDGE_API_KEY (yields 401)",
            fix: 'run setup to align them, or reinstall the service',
        });
    }
    else if (serviceEnv?.BRIDGE_API_KEY !== undefined) {
        ok.push('key matches the service');
    }
    if (serviceEnv?.BRIDGE_PORT !== undefined && typeof env.ANTHROPIC_BASE_URL === 'string') {
        const port = /:(\d+)\s*$/.exec(env.ANTHROPIC_BASE_URL)?.[1];
        if (port !== undefined && port !== String(serviceEnv.BRIDGE_PORT)) {
            issues.push({
                level: 'fail',
                text: `BASE_URL's port ${port} does not match the service port ${serviceEnv.BRIDGE_PORT}`,
                fix: 'run setup to align them',
            });
        }
    }
    const model = env.ANTHROPIC_MODEL;
    if (typeof model === 'string' && model !== '' && settings?.model !== undefined && settings.model !== model) {
        issues.push({
            level: 'warn',
            text: `top-level model (${settings.model}) does not match ANTHROPIC_MODEL (${model}); another model may run silently`,
            fix: 'run setup to rewrite both (the two fields are written with the same value)',
        });
    }
    else if (typeof model === 'string' && model !== '') {
        ok.push(`model ${model}`);
    }
    if (serviceCli !== undefined && runningCli !== undefined && serviceCli !== runningCli) {
        issues.push({
            level: 'fail',
            text: `the service is not running this copy of the code: ${serviceCli}`,
            fix: 'rerun setup from this copy (the global install is a snapshot; git pull does not update it)',
        });
    }
    else if (serviceCli !== undefined) {
        ok.push('the service and the current command are the same code');
    }
    if (healthOk === false)
        issues.push({
            level: 'fail',
            text: 'nothing is running on the port the configuration points at (Claude Code gets ECONNREFUSED)',
            fix: 'run setup and agree to install the background service',
        });
    else if (healthOk === true)
        ok.push('/health responds');
    return { issues, ok };
}
/** Read the real machine state and feed it to `localIssues`. */
export function localSnapshot() {
    const settingsFile = claudeSettingsPath();
    let settings = {};
    try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
    catch {
        /* absent means not configured */
    }
    const state = readInstallState();
    const service = serviceState();
    return {
        settingsFile,
        settings,
        service,
        legacyHome: legacyHomeInUse(),
        serviceEnv: state?.service?.env,
        serviceCli: service.installed ? serviceCliPath() : undefined,
        runningCli: currentCliPath(),
    };
}
/** Login status check (no network). */
export function credentialChecks() {
    const rows = [];
    for (const source of SOURCES) {
        if (!needsLogin(source)) {
            rows.push({ label: source.label, ok: true, text: 'no login required (anonymous free tier)' });
            continue;
        }
        if (source.auth === 'key') {
            rows.push(hasGoCredential()
                ? { label: source.label, ok: true, text: `API key configured (last four ${goKeyTail()})` }
                : {
                    label: source.label,
                    ok: false,
                    text: 'no API key configured',
                    fix: 'pick the OpenCode Go plan in the setup menu and enter the key',
                });
            continue;
        }
        if (source.kind === 'openai')
            continue;
        const status = credentialStatus(source);
        if (!status.loggedIn) {
            rows.push({ label: source.label, ok: false, text: 'not logged in', fix: `fo login ${source.id}` });
            continue;
        }
        const soon = status.expiresAt !== undefined && status.expiresAt - Date.now() < 7 * 24 * 3600 * 1000;
        rows.push({
            label: source.label,
            ok: !soon,
            text: `${status.nickname === '' ? 'logged in' : status.nickname}${status.expiresAt === undefined ? '' : ` · expires ${new Date(status.expiresAt).toLocaleDateString('zh-CN')}`}`,
            ...(soon ? { fix: 'expiring soon; run login once to renew' } : {}),
        });
    }
    return rows;
}
