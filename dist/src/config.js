// Configuration: environment variables first, command line on top, then the
// subcommand decides what runs.
//
// Deliberately no configuration file — the bridge's entire state is "which
// upstream, which port", and environment variables are both sufficient and a
// single source of truth when the values are also written into Claude Code's
// `settings.json`. The only file this program persists is the login credential
// (see {@link credentialFile}).
import fs from 'node:fs';
import { isIP } from 'node:net';
import { SUBTYPES, validationError, configError } from "./errors.js";
import os from 'node:os';
import path from 'node:path';
import { SOURCE_NAMES, sourceByName, defaultSources } from "./sources.js";
import { bridgeHome, credentialFile } from "./home.js";
export const DEFAULTS = {
    /**
     * `direct` = log in to Tencent's products ourselves; `gateway` = forward to any
     * OpenAI-compatible endpoint.
     */
    mode: 'direct',
    host: '127.0.0.1',
    port: 8788,
    /** The gateway-mode upstream; defaults to the local channel gateway. */
    upstream: 'http://127.0.0.1:8326',
    upstreamKey: '',
    /** Empty = decided by the upstream catalogue (direct mode takes the first available model). */
    model: '',
    /** This bridge's own gate; empty means serve only this machine and check no caller. */
    apiKey: '',
    /** An explicit map of the form `{"claude-haiku-4-5":"cn/deepseek-v4.1-flash"}`. */
    modelMap: {},
    maxTokensCap: 0,
    showThinking: false,
    heartbeatMs: 15000,
    /**
     * How long the upstream may stay silent before it counts as dead.
     *
     * Paired with `heartbeatMs`: the heartbeat tells the client "still thinking", the watchdog
     * ends the turn when the upstream is "connected but never emits a byte". A reasoning
     * model's first byte can take 70 seconds or more, so this has to be noticeably loose; 0
     * disables it (back to the old "you can only ^C" behaviour).
     */
    upstreamIdleMs: 180_000,
    /**
     * Default reasoning level when writing the DSH provider; `none` = do not write it (DSH shows
     * Default).
     */
    dshReasoning: undefined,
    /**
     * Whether to narrowly rewrite known content fingerprints for the Tencent backends (see
     * src/fingerprint.ts).
     */
    fingerprintRewrite: true,
    /** The sources mounted at once; their order decides who gets an unprefixed model ID. */
    products: defaultSources(),
    quiet: false,
};
/**
 * Default local token.
 *
 * Loopback (127.0.0.1) does not really need a token, but both Claude Code and DSH
 * require one to be filled in. It is therefore a **fixed** default rather than a
 * random value minted on each setup: rotating the key invalidates the client
 * configuration that already holds it (and the reference in DSH's credential
 * seam). This is exactly how it broke on a real machine on 2026-10-22 — DSH still
 * held the previous key, and one `setup` run produced "invalid key".
 *
 * To change it: `--api-key <x>` / `BRIDGE_API_KEY`. To drop the gate entirely: set
 * it empty (loopback only).
 */
export const DEFAULT_LOCAL_API_KEY = 'flow-one-local';
/**
 * Only literal loopback addresses are trusted; a hostname's resolution can change with the
 * environment.
 */
export function validateListenAuth({ host, apiKey }) {
    const address = String(host ?? '');
    const ipVersion = isIP(address);
    const loopback = ipVersion === 4
        ? address.startsWith('127.')
        : ipVersion === 6 && new URL(`http://[${address.split('%')[0]}]`).hostname === '[::1]';
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!loopback && (key === '' || key === DEFAULT_LOCAL_API_KEY)) {
        throw validationError(SUBTYPES.INVALID_REQUEST, 'a non-loopback listener cannot use an empty or public default key')
            .withParam('--api-key')
            .withHint('Set a custom --api-key / BRIDGE_API_KEY, or listen on --host 127.0.0.1 / ::1.');
    }
}
/**
 * The default model in gateway mode: WorkBuddy International's usual model in the DSH channel
 * gateway.
 */
const GATEWAY_DEFAULT_MODEL = 'workbuddy/deepseek-v4.1-flash';
const SUBCOMMANDS = new Set(['login', 'status', 'models', 'setup', 'uninstall', 'switch', 'use', 'doctor', 'client']);
/**
 * The data directory location lives in `home.ts` (which imports nothing from this project, to
 * avoid cycles).
 */
export { bridgeHome, credentialFile };
/**
 * The local channel gateway keeps its key under the DSH home; gateway mode reads
 * it from there by convention when nothing is configured explicitly. If it cannot be read,
 * treat it as absent (the gateway answers 401, which makes it obvious the key was not given).
 */
export function readDshGatewayKey(env = process.env, home = os.homedir()) {
    const fromEnv = String(env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim();
    if (fromEnv !== '')
        return { key: fromEnv, path: null };
    const dshHome = String(env.DSH_HOME ?? '').trim() || path.join(home, '.dsh');
    const file = path.join(dshHome, 'openai-gateway', 'api-key');
    try {
        const key = fs.readFileSync(file, 'utf8').trim();
        if (key !== '')
            return { key, path: file };
    }
    catch {
        /* the plugin was never installed, or no key has been generated yet */
    }
    return { key: '', path: null };
}
export const USAGE = `flow-one — run the Claude Code CLI on WorkBuddy (China / International) and the OpenCode free tier

Usage:
  flow-one                    start the reverse proxy
  flow-one login [cn|intl]    log in (both when no product name is given)
  flow-one status             show login status
  flow-one models             list available model IDs
  flow-one switch             pick a backend model (keeps the unified entry when available)
  flow-one use <cn|intl|oc|ocg>  switch to a configured source
                              when multiple sources are available
  flow-one doctor             self-check: config / login / both gates (really sends requests)
  flow-one setup              interactive one-shot setup (login → pick model → configure the proxy
                              → optionally configure your clients)
  flow-one client             print the connection details (address / token / model ID) to fill in yourself
  flow-one uninstall          restore what this tool wrote and uninstall the background service

Options:
  --mode <direct|gateway>  talk to Tencent directly (default), or forward to an OpenAI-compatible upstream
  --product <cn|intl|oc|ocg>  mount only the named sources, repeatable; defaults to everything configured
  --host <address>          listen address (default ${DEFAULTS.host})
  --port <port>             listen port (default ${DEFAULTS.port})
  --model <ID>              default model ID; in direct mode the upstream catalogue decides when omitted
  --map <A=B,C=D>           explicit map from Claude model name → upstream model ID
  --api-key <KEY>           this bridge's own gate key (no check when omitted, loopback only)
                            setup writes the fixed default flow-one-local on first run and reuses it
                            from then on (the key never rotates)
  --json                    render errors as a one-line JSON envelope on stderr (for scripts)
  --service / --no-service  background service: state it explicitly (overrides the remembered choice)
  --dsh-reasoning <level>   default reasoning level when writing the DSH provider (off/minimal/low/medium/high/
                            xhigh/max, none = do not write it, let DSH show Default; default high)
  --clients <list>          which clients to configure: claude,dsh / claude / dsh / none
                            (by default both are asked separately and the answers remembered; none = configure
                            the proxy only and touch no client file)
                            the old --client / --no-client are still accepted, equivalent to claude / none
  --version, -v             print the version
  --max-tokens <N>          cap max_tokens before forwarding; 0 means no cap
  --heartbeat <ms>          heartbeat interval while thinking; 0 disables it (default ${DEFAULTS.heartbeatMs})
  --upstream-idle <ms>      silence from the upstream counted as a failure; 0 disables it (default ${DEFAULTS.upstreamIdleMs})
  --no-upstream-usage       omit stream_options when an upstream rejects it (usage may be unavailable)
  --thinking                render the upstream's reasoning deltas as thinking blocks (dropped by default)
  --no-fingerprint-rewrite  disable the narrow Tencent-side content fingerprint rewrite (enabled by default, see README)
  --quiet                   print errors only
  --help                    show this help

Gateway mode only:
  --upstream <URL>         OpenAI-compatible upstream (default ${DEFAULTS.upstream})
  --upstream-key <KEY>     upstream key; when omitted, reads DSH_OPENAI_GATEWAY_API_KEY, then
                           $DSH_HOME/openai-gateway/api-key in that order

Environment: BRIDGE_MODE / BRIDGE_PRODUCTS / BRIDGE_HOST / BRIDGE_PORT / BRIDGE_MODEL /
BRIDGE_API_KEY / BRIDGE_MODEL_MAP / BRIDGE_MAX_TOKENS_CAP / BRIDGE_SHOW_THINKING /
BRIDGE_HEARTBEAT_MS / BRIDGE_UPSTREAM_USAGE / BRIDGE_FINGERPRINT_REWRITE / BRIDGE_HOME / UPSTREAM_BASE_URL /
UPSTREAM_API_KEY
`;
/** `--clients claude,dsh` / `none` -> the set of targets. */
function parseClients(raw) {
    const text = String(raw).trim().toLowerCase();
    if (text === '' || text === 'none')
        return [];
    const out = [];
    for (const item of text.split(',')) {
        const id = item.trim();
        if (id === '' || id === 'none')
            continue;
        if (id !== 'claude' && id !== 'dsh') {
            throw validationError(SUBTYPES.INVALID_FLAG, `unknown client: ${id} (expected claude / dsh / none)`).withParam('--clients');
        }
        if (!out.includes(id))
            out.push(id);
    }
    return out;
}
function parseModelMap(raw) {
    const map = {};
    for (const pair of String(raw).split(',')) {
        const at = pair.indexOf('=');
        if (at <= 0)
            continue;
        const from = pair.slice(0, at).trim();
        const to = pair.slice(at + 1).trim();
        if (from !== '' && to !== '')
            map[from] = to;
    }
    return map;
}
function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}
/** Source names -> source objects. An unknown name is an error, never a silent fallback. */
function resolveSources(names) {
    const picked = [];
    for (const { name, env } of names) {
        const source = sourceByName(name);
        if (source === undefined)
            throw (env ? configError : validationError)(SUBTYPES.UNKNOWN_SOURCE, `unknown source: ${name} (expected one of ${SOURCE_NAMES})`).withParam(env ? 'BRIDGE_PRODUCTS' : '--product');
        if (!picked.includes(source))
            picked.push(source);
    }
    return picked.length > 0 ? picked : defaultSources();
}
const FLAGS = {
    '--mode': 'mode',
    '--host': 'host',
    '--port': 'port',
    '--model': 'model',
    '--api-key': 'apiKey',
    '--map': 'modelMap',
    '--max-tokens': 'maxTokensCap',
    '--fingerprint-rewrite': 'fingerprintRewrite',
    '--heartbeat': 'heartbeatMs',
    '--upstream-idle': 'upstreamIdleMs',
    '--upstream': 'upstream',
    '--upstream-key': 'upstreamKey',
    '--product': 'product',
    '--products': 'products',
};
/**
 * Parse the command line.
 *
 * @returns {{help: boolean, command: string, commandArgs: string[], config: object}}
 */
export function resolveConfig({ env = process.env, argv = [], home = os.homedir(), } = {}) {
    const config = { ...DEFAULTS, products: [...DEFAULTS.products], modelMap: {} };
    const productNames = [];
    const explicit = new Set();
    const fromEnv = {
        mode: env.BRIDGE_MODE,
        host: env.BRIDGE_HOST,
        port: env.BRIDGE_PORT,
        upstream: env.UPSTREAM_BASE_URL,
        upstreamKey: env.UPSTREAM_API_KEY,
        model: env.BRIDGE_MODEL,
        apiKey: env.BRIDGE_API_KEY,
        heartbeatMs: env.BRIDGE_HEARTBEAT_MS,
        upstreamIdleMs: env.BRIDGE_UPSTREAM_IDLE_MS,
    };
    for (const [key, value] of Object.entries(fromEnv)) {
        if (value === undefined || String(value).trim() === '')
            continue;
        // The env table is a string map by construction; the numeric keys are converted
        // here so the rest of the code can trust the Config types.
        const target = config;
        target[key] =
            key === 'port' || key === 'heartbeatMs' || key === 'upstreamIdleMs' ? Number(value) : String(value).trim();
    }
    if (String(env.BRIDGE_MODEL_MAP ?? '').trim() !== '')
        config.modelMap = parseModelMap(env.BRIDGE_MODEL_MAP);
    if (String(env.BRIDGE_MAX_TOKENS_CAP ?? '').trim() !== '')
        config.maxTokensCap = Number(env.BRIDGE_MAX_TOKENS_CAP);
    if (env.BRIDGE_SHOW_THINKING !== undefined)
        config.showThinking = truthy(env.BRIDGE_SHOW_THINKING);
    if (env.BRIDGE_UPSTREAM_USAGE !== undefined)
        config.upstreamUsage = truthy(env.BRIDGE_UPSTREAM_USAGE);
    if (String(env.FO_DSH_REASONING ?? '').trim() !== '')
        config.dshReasoning = String(env.FO_DSH_REASONING).trim();
    if (env.BRIDGE_FINGERPRINT_REWRITE !== undefined)
        config.fingerprintRewrite = truthy(env.BRIDGE_FINGERPRINT_REWRITE);
    if (String(env.BRIDGE_PRODUCTS ?? '').trim() !== '')
        productNames.push(...String(env.BRIDGE_PRODUCTS)
            .split(',')
            .map(name => ({ name, env: true })));
    const rest = [];
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h')
            return { help: true, command: 'help', commandArgs: [], config };
        if (flag === '--no-upstream-usage') {
            config.upstreamUsage = false;
            continue;
        }
        if (flag === '--thinking') {
            config.showThinking = true;
            continue;
        }
        if (flag === '--no-fingerprint-rewrite') {
            config.fingerprintRewrite = false;
            continue;
        }
        if (flag === '--setup' || flag === '--uninstall') {
            rest.push(flag.slice(2));
            continue;
        }
        if (flag === '--quiet') {
            config.quiet = true;
            continue;
        }
        // Three argument-less switches that take effect on sight:
        //   --json        render errors as a one-line JSON envelope (for scripts; cli.ts must also
        //                 recognise it before parsing, otherwise even "the flag is wrong" cannot be
        //                 reported as JSON — both read the same argv, so they do not conflict)
        //   --service / --no-service  state explicitly whether to stay resident in the background,
        //                 overriding the remembered choice
        if (flag === '--json') {
            config.json = true;
            continue;
        }
        if (flag === '--service') {
            config.service = true;
            continue;
        }
        if (flag === '--no-service') {
            config.service = false;
            continue;
        }
        // Which clients to write configuration for: a convenience, the proxy runs without it.
        // An explicit statement wins and is not recorded in the ledger (only the wizard's question
        // is recorded, see clientChoice in install.ts).
        if (flag === '--clients') {
            const value = argv[++index];
            if (value === undefined || value.startsWith('--'))
                throw validationError(SUBTYPES.MISSING_ARGUMENT, '--clients requires a value (claude,dsh / claude / dsh / none)').withParam('--clients');
            config.clients = parseClients(value);
            continue;
        }
        // Legacy spellings: --client equals --clients claude, --no-client equals --clients none
        if (flag === '--dsh-reasoning') {
            const value = argv[++index];
            if (value === undefined || value.startsWith('--'))
                throw validationError(SUBTYPES.MISSING_ARGUMENT, '--dsh-reasoning requires a value (off/minimal/low/medium/high/xhigh/max/none)').withParam('--dsh-reasoning');
            explicit.add('dshReasoning');
            config.dshReasoning = value.trim().toLowerCase();
            continue;
        }
        if (flag === '--client') {
            config.clients = ['claude'];
            continue;
        }
        if (flag === '--no-client') {
            config.clients = [];
            continue;
        }
        if (!flag.startsWith('--')) {
            rest.push(flag);
            continue;
        }
        const field = FLAGS[flag];
        if (field === undefined)
            throw validationError(SUBTYPES.INVALID_FLAG, `unknown option: ${flag} (see --help)`).withParam(flag);
        const value = argv[++index];
        if (value === undefined || value.startsWith('--'))
            throw validationError(SUBTYPES.MISSING_ARGUMENT, `${flag} requires a value`).withParam(flag);
        explicit.add(field);
        if (field === 'port' || field === 'maxTokensCap' || field === 'heartbeatMs' || field === 'upstreamIdleMs') {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 0)
                throw validationError(field === 'port' ? SUBTYPES.INVALID_PORT : SUBTYPES.INVALID_FLAG, `${flag} needs a non-negative integer`).withParam(flag);
            config[field] = number;
        }
        else if (field === 'fingerprintRewrite') {
            config.fingerprintRewrite = truthy(value);
        }
        else if (field === 'modelMap') {
            config.modelMap = { ...config.modelMap, ...parseModelMap(value) };
        }
        else if (field === 'product' || field === 'products') {
            productNames.push(...String(value)
                .split(',')
                .map(name => ({ name, env: false })));
        }
        else {
            // Passing `--upstream` explicitly already means "I want gateway mode"; there is
            // no reason to make people type a second flag.
            if (field === 'upstream') {
                config.mode = 'gateway';
                explicit.add('mode');
            }
            ;
            config[field] = value.trim();
        }
    }
    const command = rest[0] ?? 'serve';
    const commandArgs = rest.slice(1);
    if (command !== 'serve' && !SUBCOMMANDS.has(command)) {
        throw validationError(SUBTYPES.INVALID_REQUEST, `unknown subcommand: ${command} (expected ${[...SUBCOMMANDS].join(' / ')})`);
    }
    if (config.dshReasoning !== undefined) {
        const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'];
        if (!allowed.includes(config.dshReasoning)) {
            throw (explicit.has('dshReasoning') ? validationError : configError)(SUBTYPES.INVALID_FLAG, `--dsh-reasoning must be one of ${allowed.join(' / ')}, got: ${config.dshReasoning}`).withParam(explicit.has('dshReasoning') ? '--dsh-reasoning' : 'FO_DSH_REASONING');
        }
    }
    if (config.mode !== 'direct' && config.mode !== 'gateway') {
        throw (explicit.has('mode') ? validationError : configError)(SUBTYPES.INVALID_FLAG, `--mode must be direct or gateway, got: ${config.mode}`).withParam(explicit.has('mode') ? '--mode' : 'BRIDGE_MODE');
    }
    config.products = resolveSources(productNames);
    // Existing services can still start after upgrade, but use only their former first candidate.
    if (config.mode === 'direct' && config.model === 'auto') {
        const first = env.BRIDGE_FALLBACK_MODELS?.split(',')[0]?.trim();
        const separator = first?.indexOf('/') ?? -1;
        const source = separator > 0 ? sourceByName(first?.slice(0, separator)) : undefined;
        if (!first || !source || source.id !== first.slice(0, separator) || separator === first.length - 1) {
            const error = (explicit.has('model') ? validationError : configError)(SUBTYPES.INVALID_MODEL, 'the previous automatic route has no valid first model');
            if (explicit.has('model'))
                error.withParam('--model');
            throw error.withHint('run fo setup or fo use to select a model');
        }
        config.model = first;
        if (!config.products.includes(source))
            config.products.push(source);
    }
    config.credentialFile = credentialFile(env, home);
    config.home = bridgeHome(env, home);
    if (config.mode === 'gateway') {
        const upstream = config.upstream ?? '';
        try {
            const url = new URL(upstream);
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                throw new Error('protocol');
        }
        catch {
            throw (explicit.has('upstream') ? validationError : configError)(SUBTYPES.INVALID_UPSTREAM_URL, `the upstream address is not a valid http(s) URL: ${upstream}`).withParam(explicit.has('upstream') ? '--upstream' : 'UPSTREAM_BASE_URL');
        }
        config.upstream = upstream.replace(/\/+$/, '');
        if (config.upstreamKey === '') {
            const found = readDshGatewayKey(env, home);
            config.upstreamKey = found.key;
            config.upstreamKeyPath = found.path;
        }
        // Only when "no upstream was specified", i.e. the default DSH gateway, do we pick
        // WorkBuddy's usual model for the user; when it points elsewhere (Ollama, the official
        // API, …) the catalogue decides automatically.
        if (config.model === '' && config.upstream === DEFAULTS.upstream)
            config.model = GATEWAY_DEFAULT_MODEL;
    }
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw (explicit.has('port') ? validationError : configError)(SUBTYPES.INVALID_PORT, 'the port must be an integer between 0 and 65535').withParam(explicit.has('port') ? '--port' : 'BRIDGE_PORT');
    }
    for (const [field, envName, flag] of [
        ['maxTokensCap', 'BRIDGE_MAX_TOKENS_CAP', '--max-tokens'],
        ['heartbeatMs', 'BRIDGE_HEARTBEAT_MS', '--heartbeat'],
        ['upstreamIdleMs', 'BRIDGE_UPSTREAM_IDLE_MS', '--upstream-idle'],
    ]) {
        const number = config[field] ?? 0;
        if (!Number.isInteger(number) || number < 0) {
            throw (explicit.has(field) ? validationError : configError)(SUBTYPES.INVALID_FLAG, `${flag} needs a non-negative integer`).withParam(explicit.has(field) ? flag : envName);
        }
    }
    try {
        validateListenAuth(config);
    }
    catch (error) {
        if (!explicit.has('host') && !explicit.has('apiKey') && (env.BRIDGE_HOST || env.BRIDGE_API_KEY)) {
            throw configError(SUBTYPES.INVALID_REQUEST, 'a non-loopback listener cannot use an empty or public default key')
                .withParam('BRIDGE_API_KEY')
                .withHint('Set a custom BRIDGE_API_KEY, or listen on BRIDGE_HOST 127.0.0.1 / ::1.');
        }
        throw error;
    }
    return { help: false, command, commandArgs, config };
}
