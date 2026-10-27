// Interactive UI: main menu, one-shot setup, model switching, status, restore.
//
// The shape follows [zcf](https://github.com/UfoMiao/zcf): banner → numbered sections →
// type the number; every step has a heading, long operations spin, and the run ends with
// a summary box.
//
// Two trade-offs:
// - **The menu holds only the five common actions**. Everything else (gateway mode, the
//   fingerprint switch, …) lives in command-line flags and is not piled into the menu —
//   the more options, the fewer anyone reads.
// - **Every step reports honestly**. Which file was written, where the backup went, and
//   whether the service actually came up are all shown; on failure the fix is a command
//   that can be copied and pasted as-is.
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import process from 'node:process';
import { CN, INTL } from "./products.js";
import { OPENCODE, OPENCODE_GO, goCredential, goKeyTail, hasGoCredential, saveGoKey } from "./opencode.js";
import { SOURCES, needsLogin, sourceByName } from "./sources.js";
import { credentialChecks, localIssues, localSnapshot, probeOpencodeGate, probeOpencodeGo, probeTencentFingerprint, } from "./doctor.js";
import { HEALTH_SERVICE_NAMES } from "./install.js";
import { login, credentialStatus } from "./auth.js";
import { createDirectUpstream, createGatewayUpstream } from "./upstreams.js";
import { credentialFile, DEFAULT_LOCAL_API_KEY } from "./config.js";
import { installClaudeSettings, installService, uninstallClaudeSettings, uninstallService, serviceState, serviceChoice, recordServiceChoice, claudeSettingsPath, readInstallState, serviceCliPath, currentCliPath, LEGACY_SERVICE_LABEL, CLIENT_TARGETS, clientChoice, recordClientChoice, bridgeRecord, recordBridge, sizedModelId, clientConfigIsOurs, } from "./install.js";
import { HOME_DIR, LEGACY_HOME_DIR, legacyHomeInUse } from "./home.js";
import { DEFAULT_DSH_REASONING, DSH_SOURCE_IDS, applyDshConfig, dshCurrentlyManaged, removeDshConfig } from "./dsh.js";
// The menu's "switch source" entry runs the same flow as `fo use`, just picked with
// arrow keys when no argument is given
import { useFlow } from "./use.js";
import { banner, blank, box, confirm, gray, green, heading, info, input, isInteractive, menu, note, section, select, password, spinner, style, success, warn, fail, dim, yellow, } from "./prompt.js";
import { SUBTYPES, asBridgeError, configError, renderError, upstreamError, validationError } from "./errors.js";
const DEFAULT_PORT = 8788;
/** Recommended models for Claude Code: these were verified on a real machine. */
const PREFERRED_MODELS = [
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-free',
    'hy4-preview-f',
    'deepseek-v4-flash',
    'glm-5.3',
];
function version() {
    try {
        return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '';
    }
    catch {
        return '';
    }
}
function shortNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return '';
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
    if (value >= 1000)
        return `${Math.round(value / 1000)}k`;
    return String(value);
}
function modelHint(row, recommended = false) {
    const bits = [];
    if (recommended)
        bits.push('推荐');
    if (row.free === true)
        bits.push('免费');
    if (row.contextWindow !== undefined)
        bits.push(`窗口 ${shortNumber(row.contextWindow)}`);
    if (row.maxOutputTokens !== undefined)
        bits.push(`输出 ${shortNumber(row.maxOutputTokens)}`);
    if (Array.isArray(row.efforts) && row.efforts.length > 0)
        bits.push(`档位 ${row.efforts.join('/')}`);
    if (row.supportsImages === true)
        bits.push('视觉');
    return bits.join(' · ');
}
/** Port-in-use probe: suggests a usable value earlier than "bind first, fail later" would. */
async function portAvailable(port) {
    return await new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '127.0.0.1');
    });
}
/**
 * Whether this port is occupied by **this tool's bridge** (rather than something else);
 * if so, return the configuration it reports about itself.
 *
 * Bought by a real failure: the wizard originally only asked "is the port free?", so it
 * treated **the previously installed service** as an intruder, suggested moving to 8789
 * and wrote that into the Claude Code config; the user had not installed a background
 * service that time, so 8789 was empty and Claude Code hit `ECONNREFUSED` outright.
 */
export async function probeBridge(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return undefined;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
        if (!response.ok)
            return undefined;
        const body = (await response.json());
        // Recognize both old and new names: during the rename window the port may be served
        // by the old name (see install.ts)
        return HEALTH_SERVICE_NAMES.has(String(body.service ?? '')) ? body : undefined;
    }
    catch {
        return undefined;
    }
}
/** Port decision: reuse a running instance of this tool first, then take the first free port. */
export async function choosePort(candidates = [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2, 18788]) {
    const installed = readInstallState().service?.port;
    if (installed !== undefined && installed > 0 && (await probeBridge(installed)) !== undefined)
        return installed;
    for (const port of candidates) {
        if ((await probeBridge(port)) !== undefined)
            return port;
        if (await portAvailable(port))
            return port;
    }
    throw configError(SUBTYPES.INVALID_PORT, 'no available bridge port was found').withHint('free one of the candidate ports and run setup again');
}
/** Health check: confirm the service actually listens on the port, not just that a file was written. */
async function waitHealthy(base, timeoutMs = 12_000, model) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
            if (response.ok) {
                const body = (await response.json());
                if (HEALTH_SERVICE_NAMES.has(String(body.service ?? '')) && (model === undefined || body.model === model))
                    return body;
            }
        }
        catch {
            /* not up yet */
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return undefined;
}
async function loadModels(upstream) {
    const spin = spinner('读取模型清单…');
    try {
        return await upstream.loadModels();
    }
    finally {
        spin.stop();
    }
}
function currentSettings() {
    try {
        return JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'));
    }
    catch {
        return {};
    }
}
function loggedInLabel(product) {
    if (!needsLogin(product))
        return `${product.id} no login required`;
    if (product.auth === 'key')
        return hasGoCredential() ? `${product.id} key configured` : `${product.id} no key`;
    if (product.kind === 'openai')
        return `${product.id} no login required`;
    const status = credentialStatus(product);
    if (!status.loggedIn)
        return `${product.id} not logged in`;
    return `${product.id} ${status.nickname === '' ? 'logged in' : status.nickname}`;
}
/** The two status lines at the top of the menu: know the current state without entering a submenu. */
async function statusLine() {
    const settings = currentSettings();
    const model = settings.env?.ANTHROPIC_MODEL ?? '';
    const port = Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:0').port);
    const running = await probeBridge(port);
    const service = serviceState();
    const state = running !== undefined ? green(`运行中（${port}）`) : service.installed ? '已安装但没在跑' : '未运行';
    note(`  ${gray('模型')} ${model === '' ? gray('未配置') : style.bold(model.replace('[1m]', ''))}   ${gray('服务')} ${state}`);
    note(`  ${gray('来源')} ${gray(SOURCES.map(source => loggedInLabel(source)).join(' · '))}`);
}
/** Log in source by source; skip sources that need no login, and skip ones already logged in unless `force`. */
export async function ensureLoggedIn(products, { force = false } = {}) {
    for (const product of products) {
        // Say it even for no-login sources (OpenCode free tier), so nobody thinks they were skipped by mistake
        if (!needsLogin(product)) {
            success(`${product.label} 无需登录，直接可用`);
            continue;
        }
        // The key path: there is no browser authorization, ask for the key directly
        if (product.auth === 'key') {
            if (hasGoCredential() && !force) {
                success(`${product.label} 已配 key（末四位 ${goKeyTail()}）`);
                continue;
            }
            heading(`配置 ${product.label}`);
            note(dim('  在 opencode.ai 控制台生成 API key（Go 套餐订阅里的那个），粘贴到这里。'));
            const value = await password({
                message: 'OpenCode API key',
                validate: input => (input.trim().length < 20 ? '看起来不像一个 key' : undefined),
            });
            const saved = saveGoKey(value);
            success(`已保存（末四位 ${String(saved?.apiKey ?? '').slice(-4)}），会话 id ${String(saved?.session ?? '').slice(0, 8)}…`);
            continue;
        }
        if (product.kind === 'openai')
            continue;
        const status = credentialStatus(product);
        if (status.loggedIn && !force) {
            success(`${product.label} 已登录${status.nickname === '' ? '' : `（${status.nickname}）`}`);
            continue;
        }
        heading(`登录 ${product.label}`);
        note(dim('  浏览器会打开授权页；终端里也会打印链接，SSH 环境下复制粘贴即可。'));
        try {
            await login(product, { log: (line) => note(`  ${line}`) });
        }
        catch (error) {
            fail(error instanceof Error ? error.message : String(error));
            if (!(await confirm({ message: `跳过这条来源（${product.id}），继续？`, initial: true })))
                throw error;
        }
    }
}
/**
 * Pick a model from the list.
 *
 * **List everything, no truncation** (three sources add up to well over a hundred): the
 * list filters as you type, so `glm`, `oc/deep` or `1m` narrows it instantly — an earlier
 * version drew only the first 10 and added a separate "enter a keyword to filter…" entry,
 * which effectively hid OpenCode's eighty-odd models.
 * A manual entry remains for IDs missing from the list (self-hosted gateways, new models).
 */
export async function pickModel(rows) {
    const ranked = rankRows(rows);
    const free = ranked.filter(row => row.free === true);
    const paid = ranked.filter(row => row.free !== true);
    const toOption = (row, index) => ({
        label: row.id,
        hint: modelHint(row, index === 0 && row.free !== true),
        value: row.id,
    });
    const picked = await select({
        message: '用哪个模型？',
        filterable: true,
        options: [
            // Free-tier models come first as their own group: see at a glance what costs
            // nothing, without scrolling through 88 oc models
            ...(free.length > 0 ? [{ label: `免费模型（${free.length} 个）`, value: '__free__', separator: true }] : []),
            ...free.map(toOption),
            ...(paid.length > 0
                ? [{ label: `其余模型（${paid.length} 个，按量计费 / 订阅）`, value: '__paid__', separator: true }]
                : []),
            ...paid.map(toOption),
            { label: '手动输入模型 ID', hint: '清单里没有的模型', value: '__manual__' },
        ],
    });
    if (picked === '__manual__') {
        const id = await input({
            message: '模型 ID（形如 cn/xxx、intl/xxx、oc/xxx）',
            initial: ranked[0]?.id ?? '',
            validate: value => (value === '' ? '不能为空' : undefined),
        });
        return rows.find(row => row.id === id) ?? { id };
    }
    // Return the whole row: the context window decides whether Claude Code gets `[1m]`, so the id alone is not enough
    return ranked.find(row => row.id === picked) ?? { id: picked };
}
/** Recommended models first, the rest in remote order. */
/** Free first, then by recommendation order; within a group keep the order the remote returned. */
function rankRows(rows) {
    return [...rows].sort((a, b) => {
        const free = (b.free === true ? 1 : 0) - (a.free === true ? 1 : 0);
        return free !== 0 ? free : rank(a.id) - rank(b.id);
    });
}
function rank(id) {
    const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
    const at = PREFERRED_MODELS.findIndex(preferred => bare === preferred);
    return at >= 0 ? at : PREFERRED_MODELS.length;
}
/** Gateway-mode sentinel: not a "source", yet offered alongside the three direct sources in the same question. */
const GATEWAY = 'gateway';
/**
 * This run's chosen source + the sources already mounted = the new mount list.
 *
 * Only one source is configured per run, so re-running **accumulates** rather than
 * overwrites: configure the China edition first, then come back through the menu for
 * OpenCode, and both stay mounted instead of the China edition being replaced.
 */
function mountedSources(chosen) {
    const state = readInstallState();
    const recorded = (state.service?.env ?? state.bridge?.serviceEnv)?.BRIDGE_PRODUCTS;
    const current = typeof recorded === 'string' && recorded.trim() !== ''
        ? recorded
            .split(',')
            .map(name => sourceByName(name))
            .filter(source => source !== undefined)
        : [...SOURCES];
    if (chosen === undefined)
        return current.length > 0 ? current : [...SOURCES];
    return current.includes(chosen) ? current : [...current, chosen];
}
/**
 * The DSH providers must cover **every mounted source**, not just the one chosen now.
 *
 * We hit this: `loadModels` in `setup` only loaded models for `[chosen]`, so the DSH
 * managed section was rewritten each time to "only the version just picked" — configure
 * intl then cn and intl's provider vanished (user report 2026-10-22: "the international
 * and China editions do not exist at the same time"). Here the models are refetched from
 * the mount list.
 *
 * If that fetch fails, fall back to this run's rows: one missing DSH provider must not
 * take the whole setup down.
 */
export function dshProducts(chosen, mounted = mountedSources(chosen)) {
    // Tencent's two lines only: `GATEWAY` is a pseudo-source, and oc/ocg already have their own providers in DSH
    return mounted.filter(source => SOURCES.includes(source) && DSH_SOURCE_IDS.includes(source.id));
}
async function dshModelRows(chosen, fallback) {
    const sources = dshProducts(chosen);
    if (sources.length === 0)
        return fallback;
    try {
        return await loadModels(createDirectUpstream({ products: sources, credentialFile: credentialFile() }, { log: () => { } }));
    }
    catch {
        return fallback;
    }
}
/**
 * Decide whether to install the background service this time, asking **only when needed**.
 *
 * Users complained explicitly: after installing once, every configuration run asked again
 * about auto-start. The rules:
 *   1. explicit `--service` / `--no-service` wins (scripted use needs a way to state intent);
 *   2. already installed → do not ask, just update;
 *   3. asked before and declined → do not ask, only mention how to enable it;
 *   4. never expressed → ask once (default "yes") and record the answer in `install.json`.
 *
 * `state` / `choice` / `ask` can all be injected, so tests can assert "asked or not"
 * without touching launchd / systemd.
 */
export async function decideService({ service, state = serviceState(), choice = serviceChoice(), ask = confirm, } = {}) {
    if (!state.supported) {
        warn('这个平台没有实现后台常驻，跳过（服务相关命令在 macOS 与 Linux 上可用）');
        return false;
    }
    // The flag states intent for "this run" and is not recorded: scripts pass it every time,
    // and persisting a one-off choice as a permanent preference would make the next
    // interactive run never show this question again.
    if (service !== undefined)
        return service;
    if (state.installed) {
        note(dim(`  后台服务已装（${state.kind}），本次直接更新`));
        return true;
    }
    if (choice.asked && !choice.autoStart) {
        note(dim('  按你上次的选择跳过后台服务；要开启：fo setup --service'));
        return false;
    }
    const wants = await ask({ message: '装成开机自启的后台服务？', initial: true });
    recordServiceChoice(wants);
    return wants;
}
const CLIENT_LABELS = { claude: 'Claude Code', dsh: 'DSH' };
/** Two independent yes/no questions (not "which should be configured" — that squeezes two switches into one choice). */
const CLIENT_QUESTIONS = {
    claude: '帮你也写 Claude Code 的配置（~/.claude/settings.json）？',
    dsh: '帮你也写 DSH 的配置（llm-pi-ai provider）？',
};
function labelOfClients(ids) {
    return ids.map(id => CLIENT_LABELS[id] ?? id).join(' / ');
}
/**
 * The "should we write the client config for you" question — asked once each for Claude
 * Code and DSH (two independent switches).
 *
 * This tool's job is **providing the reverse proxy**; editing client config is a favor —
 * and on Windows, touching someone else's config can trip permission errors (real machine
 * EPERM, 2026-10-19).
 *
 * ⚠️ This question is asked **every time** (unlike "install as a service"): it asks "whose
 * files are we touching this run", and users may well want only the proxy, or only DSH.
 * Asking once and never again would lock the choice in with no way to change it (user
 * report 2026-10-22). The recorded answer only serves as the **default**: pressing Enter
 * all the way reproduces last time's choice. Only an explicit `--clients` skips the question.
 *
 * Already-managed config only affects the default; when the user explicitly declines this
 * time the file must be left byte-for-byte intact.
 */
export async function decideClientTargets({ clients, ours = [], choice = clientChoice(), ask = confirm, } = {}) {
    if (Array.isArray(clients))
        return clients.filter(id => CLIENT_TARGETS.includes(id));
    const keep = [...new Set(ours.filter(id => CLIENT_TARGETS.includes(id)))];
    if (keep.length > 0) {
        note(dim(`  ${labelOfClients(keep)} 的配置本来就指向本桥：默认更新，选择不写则保留原样`));
    }
    const remembered = new Set(choice.asked ? choice.clients : []);
    const picked = [];
    // Two independent switches, one question each — no "write both" combo option: combining
    // is the UI's job, and the answer is really two booleans (zcf asks the same way: ask
    // about each thing, no multi-select).
    for (const id of CLIENT_TARGETS) {
        const managed = keep.includes(id);
        const wants = await ask({
            message: CLIENT_QUESTIONS[id],
            initial: managed || remembered.has(id),
        });
        if (wants)
            picked.push(id);
    }
    recordClientChoice(picked);
    return picked;
}
/**
 * The "write the client config or not" half of step 4.
 *
 * It is a separate function so it can be asserted offline: when the user says no,
 * **not a single byte** of their file may be touched.
 */
export function applyClientConfig({ wantsClient, file, baseUrl, apiKey, model, contextWindow, }) {
    if (wantsClient !== true)
        return { written: false };
    return { written: true, ...installClaudeSettings({ file, baseUrl, apiKey, model, contextWindow }) };
}
/**
 * The bridge's gate token: **reuse the existing one, seed a fixed default on first install**.
 *
 * Earlier, every setup called `crypto.randomBytes` for a new one, so the Claude Code
 * config had to be rewritten alongside and the key referenced by the DSH credential seam
 * expired outright (real-machine symptom: DSH reported "invalid key" while the bridge was
 * in fact alive). Client config references it long-term, so it must be **stable**.
 */
export function bridgeApiKey({ record = bridgeRecord(), settings = currentSettings(), fallback = DEFAULT_LOCAL_API_KEY, } = {}) {
    const existing = record?.apiKey ?? settings?.env?.ANTHROPIC_AUTH_TOKEN;
    return typeof existing === 'string' && existing.trim() !== '' ? existing : fallback;
}
/**
 * The three items needed to configure a client by hand: base URL / token / model ID.
 *
 * It only returns text and **writes no files** — that is the whole point of the
 * "don't touch my config" path.
 */
export function connectionInfo({ port, apiKey, model, contextWindow, }) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const sized = sizedModelId(model, contextWindow);
    return [
        `接入地址  ${baseUrl}`,
        `令牌      ${apiKey}`,
        `模型 ID   ${sized}`,
        'Claude Code：把上面三项填进 settings.json 的 env —— ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL',
        'DSH：llm-pi-ai 的 provider 填 api: anthropic-messages、baseURL 同上、models 里填模型 ID；令牌存进凭据 seam 后用 apiKeyEnv 引用',
    ].join('\n');
}
/** Print the connection info with every line indented by two spaces (blank lines are not indented). */
function printConnectionInfo(info) {
    for (const line of info.split('\n'))
        note(line === '' ? '' : `  ${line}`);
}
/**
 * `fo client`: print the connection info at any time.
 *
 * People who chose "do not write client config" (especially on Windows, where touching
 * `~/.claude` is unwanted) rely on it for the port/token/model ID; users who did configure
 * can also copy it into another client.
 */
export async function clientFlow() {
    const record = bridgeRecord();
    const settings = currentSettings();
    const port = record.port ?? Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).port);
    const apiKey = record.apiKey ?? settings.env?.ANTHROPIC_AUTH_TOKEN;
    const model = record.model ?? String(settings.env?.ANTHROPIC_MODEL ?? '').replace(/\[[^\]]*\]$/, '');
    if (typeof apiKey !== 'string' || apiKey === '' || model === '') {
        throw configError(SUBTYPES.SETTINGS_MISSING, 'the bridge connection has not been configured').withHint('run fo setup first; use --clients none to configure only the bridge');
    }
    heading('接入信息');
    printConnectionInfo(connectionInfo({ port, apiKey, model, contextWindow: record.contextWindow }));
    blank();
    // Also state which clients we configured for you, so nobody assumes none were
    const managed = [];
    if (clientConfigIsOurs({ port }))
        managed.push('Claude Code（settings.json）');
    if (dshCurrentlyManaged())
        managed.push('DSH（llm-pi-ai provider）');
    note(dim(managed.length === 0
        ? '  两个客户端都没配（按你的选择）；上面的信息可以直接填'
        : `  已帮你配：${managed.join('、')}`));
    blank();
    info(`前台把桥跑起来：${serveCommand(port, apiKey, model, record.serviceEnv ?? readInstallState().service?.env)}`);
    blank();
    return 0;
}
/**
 * The command to copy verbatim to "run the bridge yourself".
 *
 * It is not written as `BRIDGE_PORT=8788 BRIDGE_API_KEY=… node cli.ts`: that is POSIX
 * assignment-prefix syntax, which Windows cmd and PowerShell both reject (copying it
 * yields "not recognized as an internal or external command") — and this hint shows up
 * most often on Windows, where there is no background service and the wizard reaches
 * this step every time. The flag form works in all three shells, and port and key match
 * what `settings.json` pins.
 */
export function serveCommand(port, apiKey, model, env = {}) {
    const args = ['fo', 'serve', '--port', String(port), '--api-key', apiKey];
    if (model)
        args.push('--model', model);
    if (env.BRIDGE_UPSTREAM_USAGE === '0')
        args.push('--no-upstream-usage');
    if (env.BRIDGE_MODE === 'gateway') {
        args.push('--mode', 'gateway');
        if (env.UPSTREAM_BASE_URL)
            args.push('--upstream', env.UPSTREAM_BASE_URL);
        if (env.UPSTREAM_API_KEY)
            args.push('--upstream-key', env.UPSTREAM_API_KEY);
    }
    else if (env.BRIDGE_PRODUCTS)
        args.push('--products', env.BRIDGE_PRODUCTS);
    return args
        .map(value => {
        if (/^[\w./:=,@+-]+$/.test(value))
            return value;
        return process.platform === 'win32' ? JSON.stringify(value) : `'${value.replace(/'/g, "'\\''")}'`;
    })
        .join(' ');
}
/**
 * One-shot setup.
 *
 * `options.service` is the caller's explicit intent (`--service` / `--no-service`);
 * `options.client` is "write the Claude Code config for me" (`--client` / `--no-client`).
 * When unset (`undefined`) both are decided from the ledger and current state; see
 * `decideService` / `decideClientConfig`.
 */
export async function setupWizard(options = {}) {
    // Setup is menu interaction throughout: without a TTY (systemd, launchd, a pipe, an
    // agent invoking it) it used to print the menu anyway, get `undefined`, and then
    // **exit 0** — the caller believed it was configured while not a byte had been written
    // (real machine 2026-10-22: `fo setup --clients dsh …` succeeded silently).
    // Such a failure must be stated on the spot, not leave a fake success behind.
    if (!isInteractive()) {
        throw validationError(SUBTYPES.INVALID_REQUEST, 'setup needs an interactive terminal (stdin/stdout is not a TTY)').withHint('For non-interactive use: run the proxy in the foreground with `flow-one`, then write ' +
            'the client config yourself; get the connection info from `flow-one client` ' +
            '(base URL / token / model ID)');
    }
    heading('一键配置');
    note(dim('  一次配一家：接哪一家 → 登录 → 选模型 → 配反代（客户端配置可选）→ 常驻'));
    note(dim('  想再挂一家，配完回菜单再选一次「一键配置」即可（不会顶掉先前的）'));
    blank();
    section('第 1 步 · 接哪一家');
    const chosen = (await select({
        message: '接哪一家？',
        options: [
            { label: 'WorkBuddy 国内版（CodeBuddy）', hint: loggedInLabel(CN), value: CN },
            { label: 'WorkBuddy 国际版', hint: loggedInLabel(INTL), value: INTL },
            { label: 'OpenCode 免费档', hint: `${loggedInLabel(OPENCODE)}，免费模型`, value: OPENCODE },
            {
                label: 'OpenCode Go 套餐',
                hint: `${loggedInLabel(OPENCODE_GO)}，付费订阅（DeepSeek V4.1 Pro、GLM、Kimi、Grok…）`,
                value: OPENCODE_GO,
            },
            { label: '转发给已有的 OpenAI 兼容网关', hint: '自建网关 / LiteLLM / Ollama', value: GATEWAY },
        ],
    }));
    blank();
    section('第 2 步 · 登录');
    let upstream;
    const serviceEnv = {};
    if (options.upstreamUsage === false)
        serviceEnv.BRIDGE_UPSTREAM_USAGE = '0';
    if (chosen === GATEWAY) {
        const base = await input({
            message: '上游地址',
            initial: 'http://127.0.0.1:8326',
            validate: value => {
                try {
                    const url = new URL(value);
                    return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : '只支持 http/https';
                }
                catch {
                    return '不是合法的 URL';
                }
            },
        });
        const key = await input({ message: '上游密钥（没有就直接回车）', initial: '' });
        upstream = createGatewayUpstream({ upstream: base.replace(/\/+$/, ''), upstreamKey: key });
        serviceEnv.BRIDGE_MODE = 'gateway';
        serviceEnv.UPSTREAM_BASE_URL = base.replace(/\/+$/, '');
        if (key !== '')
            serviceEnv.UPSTREAM_API_KEY = key;
    }
    else {
        await ensureLoggedIn([chosen]);
        upstream = createDirectUpstream({ products: [chosen], credentialFile: credentialFile() }, { log: (line) => note(`  ${dim(line)}`) });
        serviceEnv.BRIDGE_MODE = 'direct';
        serviceEnv.BRIDGE_PRODUCTS = mountedSources(chosen)
            .map(source => source.id)
            .join(',');
    }
    let rows = [];
    try {
        rows = await loadModels(upstream);
    }
    catch (error) {
        fail(`拿不到模型清单：${error instanceof Error ? error.message : String(error)}`);
    }
    if (rows.length === 0) {
        throw configError(SUBTYPES.NO_SOURCES, 'no models are available').withHint('check the login or upstream address and run setup again');
    }
    success(`${rows.length} 个模型可用`);
    blank();
    section('第 3 步 · 模型');
    const picked = await pickModel(rows);
    const model = picked.id;
    serviceEnv.BRIDGE_MODEL = model;
    blank();
    section('第 4 步 · 写入并常驻');
    // The port is not offered as a choice: reuse a running instance of this tool, else take the first free port.
    const port = await choosePort();
    // The token must be stable: client config references it long-term (a random one causes
    // Claude Code 401s and DSH "invalid key")
    const apiKey = bridgeApiKey();
    const ours = [];
    if (clientConfigIsOurs({ port }))
        ours.push('claude');
    if (dshCurrentlyManaged())
        ours.push('dsh');
    const targets = await decideClientTargets({ clients: options.clients, ours });
    // Connection parameters are independent of "write client config": the ledger always
    // needs them, `fo client` and a foreground bridge rely on it
    recordBridge({ port, apiKey, model, contextWindow: picked.contextWindow, serviceEnv });
    const applied = applyClientConfig({
        wantsClient: targets.includes('claude'),
        file: claudeSettingsPath(),
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey,
        model,
        contextWindow: picked.contextWindow,
    });
    if (applied.written) {
        success(`Claude Code 配置已写入 ${applied.file}`);
        if (applied.backup !== undefined)
            note(`  ${gray(`原文件已备份：${applied.backup}`)}`);
    }
    // DSH: write the llm-pi-ai provider + credential seam (Tencent's two lines only; oc/ocg already exist in DSH)
    let dsh = { ok: true, skipped: true };
    if (targets.includes('dsh')) {
        dsh = applyDshConfig({
            port,
            apiKey,
            rows: await dshModelRows(chosen, rows),
            // The default effort stays pinned to high (matching DSH's own provider); only
            // `--dsh-reasoning none` keeps Default
            reasoning: options.dshReasoning ?? DEFAULT_DSH_REASONING,
        });
        if (dsh.ok) {
            success(`DSH provider 已写入 ${dsh.file}（${dsh.models} 个模型）`);
            note(dim('  重启 DSH 后，模型选择器里会出现 WorkBuddy 国内版 / 国际版'));
            if (dsh.backup !== undefined)
                note(`  ${gray(`原文件已备份：${dsh.backup}`)}`);
        }
        else {
            warn(`DSH 没配上：${dsh.reason}`);
        }
    }
    if (targets.length === 0) {
        note(dim('  只配反代，没动任何客户端配置；接入信息在最后，随时可用 fo client 再看'));
    }
    const running = await probeBridge(port);
    const wantsService = await decideService({ service: options.service });
    let service;
    let health;
    if (wantsService) {
        service = await installService({ port, apiKey, env: serviceEnv });
        if (service.ok) {
            success(`后台服务已装（${service.kind}）`);
            const spin = spinner('等待服务就绪…');
            health = await waitHealthy(`http://127.0.0.1:${port}`, 12_000, model);
            spin.stop();
            if (health === undefined) {
                warn('12 秒内没等到 /health 应答。看日志：');
                note(`  ${gray(serviceState().kind === 'launchd' ? '~/.flow-one/bridge.err.log' : 'journalctl --user -u dev.flow-one')}`);
            }
        }
        else {
            fail(String(service.reason ?? ''));
            warn(`先手动跑起来：${serveCommand(port, apiKey, model, serviceEnv)}`);
        }
    }
    else if (running === undefined) {
        // Config already points at this port yet nothing is listening — say so on the spot,
        // otherwise the user goes back to Claude Code and sees nothing but ECONNREFUSED.
        fail(`端口 ${port} 上没有服务在跑，Claude Code 会连不上`);
        warn(`先把桥跑起来：${serveCommand(port, apiKey, model, serviceEnv)}`);
    }
    else if (running.model !== model) {
        warn(`端口 ${port} 上已有服务在跑，但它钉的模型是 ${running.model}；要换成 ${model} 需要重装服务`);
    }
    else {
        success(`复用端口 ${port} 上已在运行的服务`);
    }
    blank();
    const mounted = chosen === GATEWAY ? ['上游网关'] : mountedSources(chosen).map(source => `${source.id}（${source.label}）`);
    box([
        wantsService && (service?.ok !== true || health === undefined) ? '配置已写入，服务未就绪' : '配置完成',
        `${gray('本次')}  ${chosen === GATEWAY ? '转发给已有网关' : `${chosen.id}（${chosen.label}）`}`,
        `${gray('模型')}  ${model}${picked.contextWindow === undefined ? '' : `  ${gray(`窗口 ${shortNumber(picked.contextWindow)}`)}`}`,
        `${gray('已挂')}  ${mounted.join('、')}`,
        `${gray('监听')}  http://127.0.0.1:${port}`,
        `${gray('服务')}  ${wantsService ? (service?.ok !== true ? '安装失败' : health === undefined ? '已安装但未就绪' : '运行中') : running === undefined ? '未常驻' : '复用已有实例'}`,
        `${gray('客户端')}  ${targets.length === 0 ? '都没动（自己填接入信息）' : [applied.written ? 'Claude Code' : '', dsh.ok === true && targets.includes('dsh') ? 'DSH' : ''].filter(Boolean).join(' + ')}`,
    ], { color: wantsService && (service?.ok !== true || health === undefined) ? yellow : green });
    if (targets.length === 0) {
        blank();
        note(style.bold('  把下面三项填到你自己的客户端里（本工具没有改任何配置文件）'));
        printConnectionInfo(connectionInfo({ port, apiKey, model, contextWindow: picked.contextWindow }));
        note(dim('  随时再看一眼：fo client'));
    }
    blank();
    if (wantsService && (service?.ok !== true || health === undefined)) {
        throw configError(SUBTYPES.SERVICE_UNSUPPORTED, 'the service is not ready').withHint(service?.reason ?? 'check the service logs and retry');
    }
    if (health !== undefined || (!wantsService && running?.model === model))
        info(`现在直接在任意目录运行 ${style.bold('claude')} 即可`);
    note(dim('  再挂一家：菜单里再选一次「一键配置」   改模型：「切换模型」   还原：「还原配置」'));
    blank();
}
/**
 * Change only the model: config file and service together.
 *
 * The service is **started without arguments** and the model is passed via environment
 * variables, so it must be reinstalled before the change takes effect.
 */
export async function switchModel() {
    if (!isInteractive())
        throw validationError(SUBTYPES.INVALID_REQUEST, 'switch needs an interactive terminal').withHint('run fo switch in a terminal');
    heading('切换模型');
    const installed = readInstallState();
    const settings = currentSettings();
    // Connection params are read from the ledger's bridge section first: users who chose
    // "do not write client config" have no keys of ours in settings.json
    const record = bridgeRecord();
    const port = record.port ?? Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).port);
    const apiKey = bridgeApiKey({ record, settings });
    const env = installed.service?.env ?? record.serviceEnv ?? {};
    const upstream = env.BRIDGE_MODE === 'gateway'
        ? createGatewayUpstream({
            upstream: env.UPSTREAM_BASE_URL ?? 'http://127.0.0.1:8326',
            upstreamKey: env.UPSTREAM_API_KEY ?? '',
        })
        : // List only genuinely mounted sources; never offer a model that would surely be missing after switching
            createDirectUpstream({ products: mountedSources(undefined), credentialFile: credentialFile() }, { log: () => { } });
    let rows;
    try {
        rows = await loadModels(upstream);
    }
    catch (error) {
        throw configError(SUBTYPES.NO_SOURCES, 'the model catalogue could not be loaded').withHint(error instanceof Error ? error.message : String(error));
    }
    if (rows.length === 0) {
        throw configError(SUBTYPES.NO_SOURCES, 'no models are available').withHint('run fo setup to check the login or upstream');
    }
    const current = String(record.model ?? settings.env?.ANTHROPIC_MODEL ?? '').replace(/\[[^\]]*\]$/, '');
    const ranked = [...rows].sort((a, b) => rank(a.id) - rank(b.id));
    // Only the first 12 are shown, so the index of the "current model" must be computed on the **truncated** list.
    const shown = ranked.slice(0, 12);
    const chosen = await select({
        message: '换成哪个模型？',
        initial: Math.max(0, shown.findIndex(row => row.id === current)),
        options: shown.map((row, index) => ({ label: row.id, hint: modelHint(row, index === 0), value: row.id })),
    });
    const model = chosen;
    const contextWindow = shown.find(row => row.id === chosen)?.contextWindow;
    if (installed.service?.path !== undefined && fs.existsSync(installed.service.path)) {
        const service = await installService({ port, apiKey, env: { ...env, BRIDGE_MODEL: model } });
        if (!service.ok)
            throw configError(SUBTYPES.SERVICE_UNSUPPORTED, 'the service could not be restarted').withHint(service.reason ?? 'check the service configuration and retry');
        const spin = spinner('重启服务…');
        const health = await waitHealthy(`http://127.0.0.1:${port}`, 12_000, model);
        spin.stop();
        if (health === undefined || health.model !== model) {
            throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'the service did not start with the selected model').withHint('check the service logs and retry');
        }
        success(`服务已在 ${port} 上按新模型运行`);
    }
    else {
        warn(`没有装后台服务，前台运行请使用：${serveCommand(port, apiKey, model, env)}`);
    }
    recordBridge({ port, apiKey, model, contextWindow, serviceEnv: { ...env, BRIDGE_MODEL: model } });
    // Config pointing at this bridge must be written back: change the key/model without
    // writing and the client keeps the old token and gets 401s.
    // Only config "not belonging to this bridge" is left untouched (that is the user's own).
    if (clientConfigIsOurs({ port })) {
        installClaudeSettings({
            file: claudeSettingsPath(),
            baseUrl: `http://127.0.0.1:${port}`,
            apiKey,
            model,
            contextWindow,
        });
        success(`配置已更新：${sizedModelId(model, contextWindow)}`);
    }
    else {
        note(dim(`  没动 Claude Code 的配置（按你上次的选择）；新模型 ID：${sizedModelId(model, contextWindow)}（fo client 可再看）`));
    }
    blank();
    return 0;
}
export async function statusFlow() {
    heading('状态');
    for (const product of SOURCES) {
        if (!needsLogin(product)) {
            note(`  ${product.id.padEnd(5)} ${product.label}  ${gray('无需登录（免费档）')}`);
            continue;
        }
        // The Go plan credential is a key (stored under the `opencode-go` entry), not a login
        // session; reading credentialStatus by `ocg` always comes back empty, so a configured
        // plan would still show as "not logged in".
        if (product.auth === 'key') {
            note(`  ${product.id.padEnd(5)} ${product.label}  ${gray(hasGoCredential() ? '已配 key' : '未配 key（在 `fo setup` 里填）')}`);
            continue;
        }
        if (product.kind === 'openai')
            continue;
        const status = credentialStatus(product);
        if (!status.loggedIn) {
            note(`  ${product.id.padEnd(5)} ${product.label}  ${gray('未登录')}`);
            continue;
        }
        const when = status.expiresAt === undefined ? '' : new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false });
        note(`  ${product.id.padEnd(5)} ${product.label}  ${status.nickname === '' ? '已登录' : status.nickname}`);
        note(`        ${gray(`${when}${status.refreshable ? ' · 可静默续期' : ''}`)}`);
    }
    const service = serviceState();
    const settings = currentSettings();
    const port = Number(new URL(settings.env?.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:0').port);
    const running = await probeBridge(port);
    blank();
    if (!service.installed && service.legacyInstalled) {
        // The most misread state: the UI says "not installed" while the old service is in fact running and holding the port
        note(`  服务      ${yellow('未安装（但改名前的旧服务还在跑）')} ${running === undefined ? gray('未在运行') : green(`运行中 ${port}`)}`);
        note(gray('            → 跑一次「一键配置」会装成新名字并顺手清掉旧服务；只想清旧的：fo uninstall'));
    }
    else {
        note(`  服务      ${service.installed ? `已安装（${service.kind}）` : '未安装'} ${running === undefined ? gray('未在运行') : green(`运行中 ${port}`)}`);
    }
    if (legacyHomeInUse()) {
        note(`  数据目录  ${gray(`还是改名前的 ~/${LEGACY_HOME_DIR}（照常用，登录态在里面）`)}`);
        note(gray(`            → 想搬到新名字：mv ~/${LEGACY_HOME_DIR} ~/${HOME_DIR}`));
    }
    note(`  服务文件  ${gray(service.path === '' ? '-' : service.path)}`);
    const runningCode = service.installed ? serviceCliPath() : undefined;
    if (runningCode !== undefined && runningCode !== currentCliPath()) {
        // A pit we actually hit: the service points at a snapshot of the global install, so
        // "present on the command line, absent in the service"
        note(`  服务代码  ${yellow(runningCode)}`);
        warn('服务跑的不是当前这份代码（全局安装是一份快照）；`fo setup` 重装一次即可对齐');
    }
    else if (runningCode !== undefined) {
        note(`  服务代码  ${gray(runningCode)}`);
    }
    note(`  配置文件  ${gray(readInstallState().claudeSettings?.file ?? '本工具未写入过')}`);
    note(`  凭据文件  ${gray(credentialFile())}`);
    blank();
    return 0;
}
export async function uninstallFlow() {
    heading('还原配置');
    const settings = uninstallClaudeSettings();
    if (settings.skipped === true)
        note(`  Claude Code 配置：${settings.reason}`);
    else
        success(`已从 ${settings.file} 移除 ${settings.removed?.length ?? 0} 个键`);
    if (settings.backup !== undefined)
        note(`  ${gray(`还原前的备份：${settings.backup}`)}`);
    const service = uninstallService();
    if (service.skipped === true)
        note(`  后台服务：${service.reason}`);
    else
        success(`已卸载后台服务（${service.kind}）`);
    const dsh = removeDshConfig();
    if (dsh.removed)
        success('已清掉 DSH 里的 flow-one provider 与凭据引用');
    else
        note('  DSH：没有本工具写入的记录');
    blank();
    return 0;
}
/** Log in again / switch account. */
export async function loginFlow() {
    heading('重新登录');
    const which = await select({
        message: '登录哪一条？',
        options: [
            { label: '两条都重新登录', hint: `${loggedInLabel(CN)} / ${loggedInLabel(INTL)}`, value: [CN, INTL] },
            { label: '国内版（CodeBuddy）', hint: loggedInLabel(CN), value: [CN] },
            { label: '国际版（WorkBuddy）', hint: loggedInLabel(INTL), value: [INTL] },
            { label: 'OpenCode Go 套餐（换 key）', hint: loggedInLabel(OPENCODE_GO), value: [OPENCODE_GO] },
        ],
    });
    await ensureLoggedIn(which, { force: true });
    blank();
    return 0;
}
/**
 * Self-check.
 *
 * The functional core rests on two other people's rules (Tencent's content-moderation
 * literals, OpenCode's free-tier shape gate), and either can change. This does not merely
 * check "is it alive" but **re-derives both gates** and prints each item's verdict — when
 * an upstream tightens, users can see for themselves which rule broke.
 */
export async function doctorFlow() {
    heading('自检');
    section('配置与服务');
    const snapshot = localSnapshot();
    note(`  ${gray(snapshot.settingsFile)}`);
    const url = snapshot.settings?.env?.ANTHROPIC_BASE_URL;
    const port = typeof url === 'string' ? Number(/:([0-9]+)\s*$/.exec(url)?.[1]) : undefined;
    // "Is anything listening on the port" can only be answered by **probing**, never
    // inferred from "was a service file installed": the port may be served by a pre-rename
    // service (different label → installed is false) or by a foreground process.
    // Hit on a real machine: the service was running and claude worked, yet doctor reported
    // "no service running" — a service under the old label did not count as installed, so it
    // judged false without even probing.
    const healthOk = Number.isFinite(port) ? (await probeBridge(port)) !== undefined : false;
    const { issues, ok } = localIssues({ ...snapshot, healthOk });
    for (const text of ok)
        success(text);
    for (const issue of issues) {
        if (issue.level === 'fail')
            fail(issue.text);
        else
            warn(issue.text);
        if (issue.fix !== undefined)
            note(`  ${dim(`→ ${issue.fix}`)}`);
    }
    if (ok.length === 0 && issues.length === 0)
        warn('没读到任何配置，可能还没配过');
    blank();
    section('登录');
    for (const row of credentialChecks()) {
        if (row.ok)
            success(`${row.label} ${row.text}`);
        else
            fail(`${row.label} ${row.text}`);
        if (row.fix !== undefined)
            note(`  ${dim(`→ ${row.fix}`)}`);
    }
    blank();
    section('腾讯内容风控（真发一次最小请求）');
    note(dim('  被拦的表现是 400 + code 11128；额度受限不算门禁问题'));
    let blocked = false;
    for (const source of SOURCES) {
        // Test Tencent's two lines only: this section validates the content-moderation
        // literal rules, unrelated to OpenCode's two paths
        if (source.auth !== 'oauth' || source.kind === 'openai')
            continue;
        const status = credentialStatus(source);
        if (!status.loggedIn) {
            note(`  ${gray(`${source.label} 未登录，跳过`)}`);
            continue;
        }
        const spin = spinner(`探测 ${source.label}…`);
        const result = await probeTencentFingerprint(source, { log: () => { } });
        spin.stop();
        if (result.ok)
            success(`${source.label} 通过（改写器生效）`);
        else if (result.limited)
            warn(`${source.label} 额度/频率受限，本次无法验证（不是门禁问题）`);
        else if (result.blocked) {
            blocked = true;
            fail(`${source.label} 被内容风控拦下：${result.message}`);
        }
        else
            fail(`${source.label} 探测失败：${result.message}`);
    }
    blank();
    const go = await probeOpencodeGo();
    section('OpenCode Go 套餐（认证通道）');
    if (go.configured !== true) {
        note(`  ${gray('未配置 API key，跳过（菜单「一键配置」里选 OpenCode Go 套餐）')}`);
    }
    else {
        note(dim(`  key 末四位 ${go.tail}；这条路没有形状门禁，但要求会话头`));
        for (const row of go.rows) {
            if (row.verdict === 'pass')
                success(`${row.label} → ${row.status}${row.count === undefined ? '' : `（${row.count} 个模型）`}`);
            else if (row.verdict === 'relaxed')
                note(`  ${yellow('○')} ${row.label} → ${row.status} ${gray('（这条已不再是必填项）')}`);
            else if (row.verdict === 'inconclusive')
                warn(`${row.label} → ${row.status || '连不上'} ${row.message ?? ''}`);
            else
                fail(`${row.label} → ${row.status} ${row.message ?? ''}`);
        }
    }
    blank();
    section('OpenCode 免费档门禁（重推一遍）');
    note(dim('  完整形状应 200；逐项去掉一个要件，应被 403 拒掉'));
    const gateSpin = spinner('探测中…');
    const gate = await probeOpencodeGate();
    gateSpin.stop();
    for (const row of gate.rows) {
        if (row.verdict === 'pass')
            success(`${row.label} → ${row.status}${row.errorType === undefined ? '' : ` ${row.errorType}`}`);
        else if (row.verdict === 'relaxed')
            note(`  ${yellow('○')} ${row.label} → ${row.status} ${gray('（这一条已不再是必填项，上游放松了）')}`);
        // "Cannot decide" has three sources, all of which go to warn rather than red: this row
        // cannot tell on its own, the whole round cannot tell (rate limit / unreachable), and
        // when the round is tightened the remaining rows are downgraded along with it.
        else if (row.verdict === 'inconclusive' || (row.verdict === 'fail' && gate.inconclusive === true)) {
            warn(`${row.label} → ${row.status || '连不上'} ${row.message ?? ''}`);
        }
        else
            fail(`${row.label} → ${row.status} ${row.errorType ?? ''} ${row.message ?? ''}`);
    }
    if (gate.tightened === true) {
        fail('完整形状已被拒 —— 上游收紧了免费档门禁');
        note(`  ${dim('规则与实测记录见 docs/gates.md，改完用 `fo doctor` 复验')}`);
    }
    else if (gate.inconclusive === true) {
        warn('没能判定门禁状态（网络或限流），稍后再试');
    }
    else {
        success('免费档门禁仍然成立');
    }
    blank();
    const verdict = issues.some(issue => issue.level === 'fail') || blocked || gate.tightened === true;
    box([
        verdict ? '自检发现问题（见上）' : '自检通过',
        `${gray('门禁')}  ${gate.tightened === true ? '免费档形状已失效' : gate.inconclusive === true ? '无法判定' : '仍然成立'}${blocked ? ' / 腾讯风控拦下了请求' : ''}`,
        `${gray('配置')}  ${issues.filter(issue => issue.level === 'fail').length} 项失败 / ${issues.length} 项提示`,
    ], { color: verdict ? yellow : green });
    blank();
    if (issues.some(issue => issue.level === 'fail')) {
        throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'the health check found configuration problems').withHint('review the diagnostic results above');
    }
    if (blocked || gate.tightened === true) {
        throw upstreamError(blocked ? SUBTYPES.CONTENT_BLOCKED : SUBTYPES.SHAPE_REJECTED, 'the upstream rejected the health check').withHint('review the diagnostic results above');
    }
    return 0;
}
/** Entered when no arguments are given and the process runs in a terminal. */
export async function mainMenu(options = {}) {
    for (;;) {
        banner('Claude Code ← WorkBuddy / OpenCode 本地反代', version());
        await statusLine();
        const choice = await menu({
            title: '请选择要做什么：',
            groups: [
                {
                    items: [
                        // Switching source is first: the most frequent daily action is "switch to
                        // another source and keep working", not reconfiguring.
                        { key: '1', label: '切换渠道', hint: '国内版 / 国际版 / 免费档 / Go 套餐，用它上次的模型' },
                        { key: '2', label: '一键配置', hint: '接哪一家 → 选模型 → 写 Claude Code 配置 → 后台常驻' },
                        { key: '3', label: '切换模型', hint: '改完自动重启服务' },
                        { key: '4', label: '查看状态', hint: '登录有效期 / 服务 / 文件位置' },
                    ],
                },
                {
                    title: '维护',
                    items: [
                        { key: '5', label: '重新登录（换账号）', hint: '浏览器授权' },
                        { key: '6', label: '自检', hint: '配置 / 登录 / 两条门禁，会真发请求' },
                        { key: '0', label: '还原配置', hint: '移除本工具写入的键并卸载后台服务' },
                        { key: 'Q', label: '退出', hint: '', danger: true },
                    ],
                },
            ],
        });
        if (choice === 'Q')
            return 0;
        try {
            if (choice === '1')
                await useFlow();
            if (choice === '2')
                await setupWizard(options);
            if (choice === '3')
                await switchModel();
            if (choice === '4')
                await statusFlow();
            if (choice === '5')
                await loginFlow();
            if (choice === '6')
                await doctorFlow();
            if (choice === '0')
                await uninstallFlow();
        }
        catch (error) {
            const typed = asBridgeError(error);
            if (typed === undefined)
                throw error;
            process.stderr.write(renderError(typed));
            warn('操作未完成，已返回主菜单');
        }
        // No more "press Enter to return to the menu": nothing clears the screen here, the
        // action's output stays above and the next banner merely appends — that pause was
        // just a wasted Enter press.
    }
}
