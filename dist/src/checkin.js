// Daily claims are isolated from inference: only an explicitly pinned domestic account runs.
// Protocol reference: dsh-our-free-model 2.1.0, credits.ts (inspected 2026-11-11).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { bridgeHome } from "./home.js";
import { ensureCredential } from "./auth.js";
import { CN } from "./products.js";
import { writeFileAtomic } from "./atomic.js";
import { SUBTYPES, authError, configError, networkError, upstreamError, validationError } from "./errors.js";
/** The reference plugin uses UTC+8, independently of the machine timezone. */
export function checkinDate(now = Date.now()) {
    return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}
/** Read local status without contacting the provider or exposing an account identifier. */
export function checkinState(home = bridgeHome()) {
    const file = path.join(home, 'checkin.json');
    if (!fs.existsSync(file))
        return {
            enabled: false,
            account: '',
            date: '',
            attempts: 0,
            nextAttemptAt: 0,
            result: 'not_enabled',
            successDate: '',
            updatedAt: 0,
        };
    try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof s.enabled !== 'boolean' ||
            !/^[a-f0-9]{64}$/.test(s.account) ||
            !Number.isInteger(s.attempts) ||
            s.attempts < 0 ||
            s.attempts > 3 ||
            !Number.isFinite(s.nextAttemptAt) ||
            !Number.isFinite(s.updatedAt) ||
            typeof s.result !== 'string' ||
            !/^(|\d{4}-\d{2}-\d{2})$/.test(s.date) ||
            !/^(|\d{4}-\d{2}-\d{2})$/.test(s.successDate))
            throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'Invalid check-in state');
        return s;
    }
    catch {
        throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'Cannot read check-in state');
    }
}
function identity(c) {
    if (!c.account?.uid)
        throw authError(SUBTYPES.NOT_LOGGED_IN, 'Domestic account identity is missing').withHint('Run fo login cn');
    return createHash('sha256')
        .update(`cn:${c.account.uid}:${c.account.enterpriseId ?? ''}`)
        .digest('hex');
}
// A loopback socket is an OS-owned lock: process death releases it without stale lock takeover races.
// Hash collisions or another application using the port fail closed, never allowing concurrent claims.
async function exclusive(home, fn) {
    const port = 40000 + (createHash('sha256').update(path.resolve(home).toLowerCase()).digest().readUInt32BE(0) % 20000);
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        server.once('error', () => reject(configError(SUBTYPES.SETTINGS_INCONSISTENT, 'Check-in lock is busy').withHint('Wait for the running check-in to finish; inspect a persistent local port conflict')));
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    try {
        return await fn();
    }
    finally {
        await new Promise(resolve => server.close(() => resolve()));
    }
}
async function credentialFor(home) {
    try {
        return await ensureCredential(CN, {
            file: path.join(home, 'credentials.json'),
            signal: AbortSignal.timeout(30_000),
        });
    }
    catch {
        throw authError(SUBTYPES.NOT_LOGGED_IN, 'Domestic login is unavailable').withHint('Run fo login cn and resume check-in');
    }
}
async function request(endpoint, c, fetcher) {
    const headers = {
        Authorization: `Bearer ${c.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Domain': CN.apiDomain,
        'X-Product': 'SaaS',
        'X-Product-Code': CN.productCode,
        'User-Agent': CN.userAgent,
    };
    if (c.account?.uid)
        headers['X-User-Id'] = c.account.uid;
    if (c.account?.enterpriseId) {
        headers['X-Enterprise-Id'] = c.account.enterpriseId;
        headers['X-Tenant-Id'] = c.account.enterpriseId;
    }
    let response;
    try {
        response = await fetcher(`${CN.endpoint}/v2/billing/meter/${endpoint}`, {
            method: 'POST',
            headers,
            body: '{}',
            signal: AbortSignal.timeout(30_000),
        });
    }
    catch {
        throw networkError(SUBTYPES.CONNECT_FAILED, 'Check-in request failed');
    }
    if (response.status === 401 || response.status === 403)
        throw authError(SUBTYPES.NOT_LOGGED_IN, 'Check-in login was rejected').withHint('Run fo login cn');
    if (!response.ok)
        throw upstreamError(SUBTYPES.BAD_STATUS, `Check-in HTTP status ${response.status}`);
    try {
        const body = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body))
            throw upstreamError(SUBTYPES.BAD_STATUS, 'Invalid check-in response');
        return body;
    }
    catch {
        throw upstreamError(SUBTYPES.BAD_STATUS, 'Invalid check-in response');
    }
}
/** Execute one bounded attempt; the external scheduler supplies wakeups, never an inference timer. */
export async function runCheckin(options = {}) {
    const home = options.home ?? bridgeHome(), now = options.now ?? Date.now;
    return exclusive(home, async () => {
        let s = checkinState(home);
        const date = checkinDate(now());
        if (!s.enabled || s.successDate === date)
            return s;
        if (s.date !== date)
            s = { ...s, date, attempts: 0, nextAttemptAt: 0 };
        if (s.attempts >= 3 || now() < s.nextAttemptAt)
            return s;
        const save = () => writeFileAtomic(path.join(home, 'checkin.json'), JSON.stringify(s, null, 2));
        // Persist the attempt before any network request so crashes cannot reset the daily retry budget.
        s = { ...s, attempts: s.attempts + 1, nextAttemptAt: now() + 15 * 60_000, result: 'running', updatedAt: now() };
        save();
        try {
            const c = await (options.credential ?? (() => credentialFor(home)))();
            if (identity(c) !== s.account)
                throw authError(SUBTYPES.NOT_LOGGED_IN, 'Domestic account changed').withHint('Explicitly enable check-in for the new account');
            const fetcher = options.fetcher ?? fetch;
            const body = await request('checkin-activity-status', c, fetcher);
            const data = body.data;
            if (body.code !== 0 || !data || typeof data.active !== 'boolean' || typeof data.today_checked_in !== 'boolean')
                throw upstreamError(SUBTYPES.BAD_STATUS, 'Check-in status was not confirmed');
            if (data.today_checked_in) {
                s.result = 'already_checked_in';
                s.successDate = date;
            }
            else if (!data.active) {
                s.result = 'inactive';
                s.attempts = 3;
            }
            else {
                // Do not claim against yesterday's status if the clock crossed midnight during the request.
                if (checkinDate(now()) !== date)
                    throw networkError(SUBTYPES.TIMEOUT, 'Check-in date changed during status query');
                const claim = await request('daily-checkin', c, fetcher);
                if (claim.code === 10001 || claim.code === 1001) {
                    s.result = 'already_checked_in';
                    s.successDate = date;
                }
                else if (claim.code === 1002 || claim.code === 1003) {
                    s.result = 'inactive';
                    s.attempts = 3;
                }
                else if (claim.code === 0 && claim.data && typeof claim.data === 'object' && !Array.isArray(claim.data)) {
                    s.result = 'claimed';
                    s.successDate = date;
                }
                else
                    throw upstreamError(SUBTYPES.BAD_STATUS, 'Daily claim was not confirmed');
            }
            s.updatedAt = now();
            save();
            return s;
        }
        catch (error) {
            s.result = 'failed';
            s.updatedAt = now();
            save();
            throw error;
        }
    });
}
/** Explicit enable pins the current cn identity; pause preserves success and retry history. */
export async function setCheckinEnabled(enabled, options = {}) {
    const home = options.home ?? bridgeHome();
    return exclusive(home, async () => {
        let s = checkinState(home);
        if (enabled) {
            const account = identity(await (options.credential ?? (() => credentialFor(home)))());
            if (s.account && account !== s.account)
                s = { ...s, date: '', attempts: 0, nextAttemptAt: 0, successDate: '', result: 'account_changed' };
            s.account = account;
        }
        else if (!s.account)
            return s;
        s.enabled = enabled;
        writeFileAtomic(path.join(home, 'checkin.json'), JSON.stringify(s, null, 2));
        return s;
    });
}
/** Noninteractive CLI output intentionally omits the persisted account hash. */
export async function checkinCommand(args) {
    const action = args[0] ?? 'status';
    if (args.length > 1 || !['status', 'enable', 'pause', 'run'].includes(action))
        throw validationError(SUBTYPES.INVALID_FLAG, 'Invalid check-in action').withHint('Use fo checkin status|enable|pause|run (cn only)');
    const s = action === 'run'
        ? await runCheckin()
        : action === 'enable' || action === 'pause'
            ? await setCheckinEnabled(action === 'enable')
            : checkinState();
    const { account: _account, ...publicState } = s;
    process.stdout.write(`${JSON.stringify({ source: 'cn', timezone: 'UTC+8', ...publicState })}\n`);
}
