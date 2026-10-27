// Tencent login: the China edition (CodeBuddy) and the International edition
// (WorkBuddy) share one `/plugin` protocol.
//
// Login is an external-link poll loop, deliberately without a local callback
// server:
//
//   POST /v2/plugin/auth/state?platform=<platform>   -> {state, authUrl}
//   open a browser at authUrl                        -> the user completes login there
//   GET  /v2/plugin/auth/token?state=<state>         -> poll for accessToken (1s, 5min timeout)
//   GET  /v2/plugin/login/account?state=<state>      -> poll for the account (uid / nickname / enterprise id)
//   POST /v2/plugin/auth/token/refresh               -> silent renewal from then on
//
// The two "not ready yet" codes must be treated as "keep waiting" rather than as
// failures: `11217` (token not ready) and `12151` (account details not complete).
// Treating them as errors makes login fail in its first second.
//
// Credentials live in `~/.flow-one/credentials.json` (0600), independent of the
// data directories used by DSH or the official clients.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { credentialFile } from "./home.js";
import { writeFileAtomic } from "./atomic.js";
const STATE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
/** How long before expiry renewal starts: enough for one network round trip. */
const REFRESH_MARGIN_MS = 120_000;
const CODE_TOKEN_NOT_READY = 11217;
const CODE_ACCOUNT_NOT_READY = 12151;
/**
 * Delay used by the login poll loop.
 *
 * This timer must **not** be unref'd. `login` is a standalone command with no
 * other handle keeping the process alive while it waits, so unref'ing it makes
 * Node exit right after printing the login link — the user authorises in the
 * browser and nobody is left to fetch the token. Integration tests cannot catch
 * this either, because the test process has its own handles. Real defect, fixed
 * 2026-10-16.
 */
const sleep = (ms) => new Promise(resolve => {
    setTimeout(resolve, ms);
});
/** Credential file location, same source as `config.credentialFile`; tests redirect it via `BRIDGE_HOME`. */
export function storePath(env = process.env, home) {
    return credentialFile(env, home);
}
/** Read on every request so a login in another process is visible immediately. */
export function readStore(file = storePath()) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
function writeStore(data, file = storePath()) {
    // Create the directory with 0700: credentials must not be readable by other
    // users on the same machine. Persisting goes through the shared atomic write —
    // on Windows a rename over an open target fails with EPERM, and the credential
    // path must not be the one place missing that fallback.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(data, null, 2), 0o600);
}
export function saveCredential(product, credential, file = storePath()) {
    writeStore({ ...readStore(file), [product.id]: credential }, file);
}
export function dropCredential(product, file = storePath()) {
    const data = { ...readStore(file) };
    delete data[product.id];
    writeStore(data, file);
}
function dataOf(body) {
    return body !== null && typeof body === 'object' ? body.data : undefined;
}
function codeOf(body) {
    const value = body !== null && typeof body === 'object' ? body.code : undefined;
    return typeof value === 'number' ? value : undefined;
}
function messageOf(body) {
    if (body === null || typeof body !== 'object')
        return '';
    for (const key of ['msg', 'message', 'displayMsg', 'errorMsg']) {
        const value = body[key];
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return '';
}
function text(value) {
    if (typeof value === 'string')
        return value.replace(/[\r\n\t]+/g, ' ').trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}
/**
 * Combine a timeout with an external cancellation signal.
 *
 * `AbortSignal.any` is deliberately not used: it only exists from Node 20.3, and
 * this project's floor is lower than that in spirit even though the current
 * engines field says 22.18.
 */
function withTimeout(timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (signal === undefined)
        return timeout;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted || timeout.aborted)
        abort();
    else {
        signal.addEventListener('abort', abort, { once: true });
        timeout.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}
async function control(method, url, headers, { timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
    const response = await fetch(url, { method, headers, signal: withTimeout(timeoutMs, signal) });
    let body = null;
    try {
        body = await response.json();
    }
    catch {
        /* an empty or non-JSON body is left to the status code */
    }
    return { status: response.status, body };
}
/** The backend may report expiry as milliseconds, seconds or an ISO string; normalise to milliseconds. */
function toEpochMs(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value > 1e12 ? value : value * 1000;
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    if (/^\d+$/.test(value.trim()))
        return toEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** The token itself carries `exp`, which is authoritative when the server sends no expiry. */
function jwtClaim(token, claim) {
    const parts = String(token).split('.');
    if (parts.length < 2)
        return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const value = payload?.[claim];
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function parseToken(data) {
    const record = (data !== null && typeof data === 'object' ? data : {});
    const accessToken = text(record.accessToken);
    const expiresAt = toEpochMs(record.expiresAt) ?? relativeEpoch(record.expiresIn) ?? jwtEpoch(accessToken, 'exp');
    const refreshExpiresAt = toEpochMs(record.refreshExpiresAt) ?? relativeEpoch(record.refreshExpiresIn);
    return {
        accessToken,
        refreshToken: text(record.refreshToken),
        tokenType: text(record.tokenType) || 'Bearer',
        domain: text(record.domain),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }),
    };
}
/** `expiresIn` is a relative "seconds still valid", measured from now. */
function relativeEpoch(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}
/** The JWT `exp` claim is the authoritative expiry; it backstops a missing absolute time. */
function jwtEpoch(token, claim) {
    const seconds = jwtClaim(token, claim);
    return seconds === undefined ? undefined : seconds * 1000;
}
/**
 * Command line that opens a browser.
 *
 * Windows must **not** go through `cmd /c start`: the login URL carries several
 * `&` separators (`platform=…&state=…&version=…`), cmd treats `&` as a command
 * separator, and the browser receives only the part before the first one — the
 * user then sees a page missing `state` (real machine, 2026-10-22).
 * `rundll32 url.dll,FileProtocolHandler` receives the URL as a plain argument
 * without shell parsing.
 */
export function browserCommand(url) {
    if (process.platform === 'darwin')
        return { command: 'open', args: [url] };
    if (process.platform === 'win32')
        return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    return { command: 'xdg-open', args: [url] };
}
/** Machines without `open` (SSH, containers) just get the link printed; that is not a failure. */
export function openInBrowser(url, log = () => { }) {
    const { command, args } = browserCommand(url);
    try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => log(`cannot open a browser automatically, open this manually: ${url}`));
        child.unref();
    }
    catch {
        log(`cannot open a browser automatically, open this manually: ${url}`);
    }
}
/**
 * The International login URL needs `version` and `loginSessionId` (the latter is
 * only a UUID for server-side log tracing; measured to carry no validation
 * meaning). Only parameters are appended — path and `state` always come from the
 * server response.
 */
function decorateLoginUrl(authUrl, product) {
    if (!product.sessionParams)
        return authUrl;
    try {
        const url = new URL(authUrl);
        if (product.pluginVersion !== undefined)
            url.searchParams.set('version', product.pluginVersion);
        url.searchParams.set('loginSessionId', crypto.randomUUID());
        return url.toString();
    }
    catch {
        return authUrl;
    }
}
export async function fetchAuthState(product, options = {}) {
    const url = `${product.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(product.platform)}`;
    const { status, body } = await control('POST', url, {
        'X-Domain': product.apiDomain,
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'User-Agent': product.userAgent,
    }, { timeoutMs: STATE_TIMEOUT_MS, signal: options.signal });
    if (status !== 200) {
        throw new Error(`${product.label}: fetching the login URL failed (HTTP ${status} ${messageOf(body)})`);
    }
    const data = dataOf(body);
    const state = text(data?.state);
    const authUrl = text(data?.authUrl);
    if (state === '' || authUrl === '') {
        throw new Error(`${product.label}: the login URL response has no state or authUrl`);
    }
    return { state, authUrl };
}
async function pollToken(product, state, options) {
    const url = `${product.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
    const headers = { 'X-No-Authorization': 'true', 'User-Agent': product.userAgent };
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (options.signal?.aborted)
            throw new Error('login cancelled');
        await sleep(POLL_INTERVAL_MS);
        let result;
        try {
            result = await control('GET', url, headers, { signal: options.signal });
        }
        catch {
            continue; // a network blip must not abort the whole login
        }
        if (result.status === 200 && dataOf(result.body) !== undefined && dataOf(result.body) !== null) {
            const token = parseToken(dataOf(result.body));
            if (token.accessToken !== '')
                return token;
            continue;
        }
        if (codeOf(result.body) === CODE_TOKEN_NOT_READY)
            continue;
        throw new Error(`${product.label}: fetching the token failed (HTTP ${result.status} code=${codeOf(result.body) ?? '-'})`);
    }
    throw new Error(`${product.label}: login timed out (authorisation not completed in the browser within 5 minutes)`);
}
async function pollAccount(product, state, token, options) {
    const url = `${product.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
    const headers = {
        // During login the domain the server just issued is authoritative; use it when non-empty.
        'X-Domain': token.domain || product.apiDomain,
        Authorization: `Bearer ${token.accessToken}`,
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'User-Agent': product.userAgent,
    };
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (options.signal?.aborted)
            throw new Error('login cancelled');
        await sleep(POLL_INTERVAL_MS);
        let result;
        try {
            result = await control('GET', url, headers, { signal: options.signal });
        }
        catch {
            continue;
        }
        const data = dataOf(result.body);
        if (result.status === 200 && data !== undefined && data !== null) {
            return {
                uid: text(data.uid),
                nickname: text(data.nickname),
                enterpriseId: text(data.enterpriseId),
                accountType: text(data.type) || 'personal',
            };
        }
        if (codeOf(result.body) === CODE_ACCOUNT_NOT_READY)
            continue;
        // Failing to read the account must not waste the whole login: the token is already
        // in hand and the nickname is display-only.
        if (result.status === 200 || result.status === 404)
            return undefined;
        throw new Error(`${product.label}: fetching the account failed (HTTP ${result.status} code=${codeOf(result.body) ?? '-'})`);
    }
    return undefined;
}
/**
 * Finish a login with an existing `state`: once authorisation is done, the
 * credential can still be collected even if the process restarted or polling was
 * interrupted. `state` is issued by the server, and stays redeemable while it has
 * not expired.
 */
export async function completeLogin(product, state, { signal, file = storePath(), log = () => { }, } = {}) {
    const token = await pollToken(product, state, { signal });
    const account = await pollAccount(product, state, token, { signal });
    const credential = { ...token, ...(account === undefined ? {} : { account }) };
    saveCredential(product, credential, file);
    log(`${product.label}: login succeeded${account?.nickname ? ` (${account.nickname})` : ''}, credential saved`);
    return credential;
}
/** Full login: obtain a state, let the user authorise in a browser, then poll for token and account. */
export async function login(product, { log = () => { }, openBrowser = openInBrowser, signal, file = storePath(), } = {}) {
    log(`${product.label}: fetching the login URL…`);
    const { state, authUrl } = await fetchAuthState(product, { signal });
    const url = decorateLoginUrl(authUrl, product);
    log(`${product.label}: complete the login in your browser:\n  ${url}`);
    openBrowser(url, log);
    log(`${product.label}: waiting for authorisation (up to 5 minutes)…`);
    return await completeLogin(product, state, { signal, file, log });
}
export async function refreshCredential(product, credential, { signal, file = storePath() } = {}) {
    if (text(credential?.refreshToken) === '') {
        throw new Error(`${product.label}: the credential has no refresh token; run login again`);
    }
    const { status, body } = await control('POST', `${product.endpoint}/v2/plugin/auth/token/refresh`, {
        'X-Domain': product.apiDomain,
        'User-Agent': product.userAgent,
        Authorization: `Bearer ${credential.accessToken ?? ''}`,
        'X-Refresh-Token': credential.refreshToken ?? '',
        'X-Auth-Refresh-Source': 'ide-main',
    }, { signal });
    if (status !== 200) {
        const message = messageOf(body);
        const expired = status === 401 || status === 403 || /expired|invalid/i.test(message);
        throw new Error(`${product.label}: ${expired ? 'login expired; run login again' : `renewal failed (HTTP ${status} ${message})`}`);
    }
    const data = dataOf(body);
    if (data === undefined || data === null)
        throw new Error(`${product.label}: the renewal response has no data`);
    const refreshed = {
        ...parseToken(data),
        ...(credential.account === undefined ? {} : { account: credential.account }),
    };
    saveCredential(product, refreshed, file);
    return refreshed;
}
/**
 * Obtain a usable credential: renew first when it is close to expiry, and report
 * a renewal failure as "login again".
 *
 * `force` covers the case where the token looks valid but the upstream just
 * answered 401. Every outbound request goes through here, so "token expired" is
 * handled exactly once for the whole chain.
 */
export async function ensureCredential(product, { log = () => { }, signal, file = storePath(), refresh = true, force = false, } = {}) {
    const stored = readStore(file)[product.id];
    if (stored === undefined || text(stored.accessToken) === '') {
        throw Object.assign(new Error(`${product.label}: not logged in; run: flow-one login ${product.id}`), {
            statusCode: 401,
        });
    }
    const expiresAt = Number(stored.expiresAt);
    const expiring = Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (!refresh || (!force && !expiring))
        return stored;
    log(`${product.label}: token is about to expire, renewing…`);
    try {
        return await refreshCredential(product, stored, { signal, file });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(message), { statusCode: 401 });
    }
}
/** For the `status` subcommand; sends no network request. */
export function credentialStatus(product, { file = storePath() } = {}) {
    const stored = readStore(file)[product.id];
    if (stored === undefined || text(stored.accessToken) === '')
        return { product: product.id, loggedIn: false };
    const expiresAt = Number(stored.expiresAt);
    return {
        product: product.id,
        label: product.label,
        loggedIn: true,
        nickname: stored.account?.nickname ?? '',
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
        expiresInMs: Number.isFinite(expiresAt) ? expiresAt - Date.now() : undefined,
        refreshable: text(stored.refreshToken) !== '',
    };
}
