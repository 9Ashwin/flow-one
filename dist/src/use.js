// `fo use <source>`: switch the provider only — go straight to an already-configured
// source instead of walking through setup again.
//
// Division of labor with `fo switch`: `switch` is "pick a model from all sources", `use`
// is "I want that provider". The latter is the frequent action (bouncing between the China
// edition / international edition / free tier / Go plan), so it must take a single command —
// and it switches using **the model that line used last**, so nobody re-picks it each time.
import { SOURCES, sourceByName } from "./sources.js";
import { DEFAULT_FALLBACK_MODELS, DEFAULT_LOCAL_API_KEY, credentialFile, resolveConfig } from "./config.js";
import { createDirectUpstream } from "./upstreams.js";
import { credentialStatus } from "./auth.js";
import { hasGoCredential } from "./opencode.js";
import { bridgeRecord, claudeSettingsPath, clientConfigIsOurs, readInstallState, recordBridge, sizedModelId, } from "./install.js";
import { applySwitch, preferredModel, serviceEnvFor } from "./switch.js";
import { SUBTYPES, configError, validationError } from "./errors.js";
import { dim, gray, input, isInteractive, note, select, style } from "./prompt.js";
function fallbackOrder(record, env) {
    return (env.BRIDGE_FALLBACK_MODELS?.split(',') ||
        DEFAULT_FALLBACK_MODELS.map(fallback => {
            const source = fallback.split('/')[0];
            const last = record.lastModels?.[source]?.model;
            return typeof last === 'string' && last.startsWith(`${source}/`) ? last : fallback;
        }));
}
/** Recommendation order for model picking (same intent as `PREFERRED_MODELS` in wizard). */
const PREFERRED_MODELS = [
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-free',
    'hy4-preview-f',
    'deepseek-v4-flash',
    'glm-5.3',
];
/** Whether this source is usable now: no-login sources always are, Tencent's two lines go by
 * login state, the Go plan by key. */
export function usableNow(product) {
    if (product.auth === 'none')
        return true;
    if (product.auth === 'key')
        return hasGoCredential();
    if (product.kind === 'openai')
        return true;
    return credentialStatus(product).loggedIn;
}
/** Why it is unusable — give only the fix, do not repeat "not logged in".
 *
 * The text stays Chinese because it is shown inside the picker's option hint, next to
 * the rest of the menu copy. */
export function unusableHint(product) {
    if (product.auth === 'key')
        return '先在 `fo setup` 里填 OpenCode API key';
    return `先登录：fo login ${product.id}`;
}
/**
 * Argument → source.
 *
 * An unknown name never falls back silently: "I said intl and it switched to cn" is far
 * harder to diagnose than an error.
 */
export function resolveSource(name) {
    // What the menu returns is already a source object; use it as is.
    if (SOURCES.includes(name))
        return name;
    const raw = String(name ?? '').trim();
    if (raw === '') {
        throw validationError(SUBTYPES.MISSING_ARGUMENT, 'say which source to switch to')
            .withParam('use')
            .withHint(`one of: ${SOURCES.map(item => item.id).join(' / ')} (e.g. \`fo use intl\`)`);
    }
    const product = sourceByName(raw);
    if (product === undefined) {
        throw validationError(SUBTYPES.UNKNOWN_SOURCE, `unknown source: ${raw}`)
            .withParam('use')
            .withHint(`one of: ${SOURCES.map(item => `${item.id} (${item.label})`).join(' / ')}`);
    }
    return product;
}
/**
 * Which model to switch to.
 *
 * Priority: the one this line used last > the first in recommendation order. **Answering
 * without querying the upstream list** is the point: a network hiccup or a slow upstream
 * must not fail "switch a source"; the list is only needed when the service really has to
 * be touched. When the list is available it fills in `contextWindow` (which decides
 * whether the client gets `[1m]`).
 */
export function modelForSource({ source, lastModels = {}, rows = [], }) {
    const onSource = rows.filter(row => row.id.startsWith(`${source.id}/`));
    const remembered = lastModels?.[source.id]?.model;
    if (onSource.length > 0) {
        return {
            model: preferredModel({
                models: onSource,
                lastModels: { [source.id]: lastModels?.[source.id] ?? undefined },
                fallback: PREFERRED_MODELS,
            }),
            contextWindow: onSource.find(row => row.id === lastModels?.[source.id]?.model)?.contextWindow,
        };
    }
    // No list available: fall back to what the ledger recorded (the full prefixed ID), and
    // if that is missing, error and send the user to setup.
    if (typeof remembered === 'string' && remembered !== '') {
        return { model: remembered, contextWindow: lastModels[source.id]?.contextWindow };
    }
    return { model: undefined };
}
/**
 * Connection parameters (port / token) currently in the ledger; the same copy `fo client` reads.
 *
 * Both are required: the service is started with them. Without a port it would be
 * installed on port 0 (a random one); without a token the client and the service do not
 * match.
 */
export function connectionOf({ record = bridgeRecord() } = {}) {
    const port = record.port;
    const apiKey = record.apiKey ?? DEFAULT_LOCAL_API_KEY;
    if (port === undefined || !Number.isInteger(port) || port <= 0) {
        throw configError(SUBTYPES.SETTINGS_MISSING, 'the ledger records no port').withHint('run `fo setup` once; after that `fo use` can switch directly');
    }
    return { port, apiKey };
}
/**
 * The menu's question: which provider to switch to.
 *
 * Same entry point as the command line, only using arrow keys when there is no argument —
 * people who enter the menu with `fo` should not have to remember the four internal names
 * `cn` / `intl` / `oc` / `ocg`. Unusable sources are still listed but dimmed: hiding them
 * makes people think "but I configured intl" when in fact it is just not logged in.
 */
export async function chooseSource({ record = bridgeRecord(), } = {}) {
    const current = String(record.model ?? '').replace(/\[[^\]]*\]$/, '');
    const currentSource = current.includes('/') ? current.slice(0, current.indexOf('/')) : '';
    const lastModels = record.lastModels ?? {};
    const env = readInstallState().service?.env ?? record.serviceEnv ?? {};
    const order = fallbackOrder(record, env).join(' → ');
    const source = await select({
        message: '选择渠道或自动回退',
        initial: current === 'auto' ? 0 : Math.max(0, SOURCES.findIndex(item => item.id === currentSource) + 1),
        options: [
            { label: '自动回退（auto）', hint: `${current === 'auto' ? '当前 · ' : ''}顺序：${order}`, value: 'auto' },
            ...SOURCES.map(product => {
                const usable = usableNow(product);
                const last = lastModels[product.id]?.model;
                const state = usable ? (last === undefined ? '还没有用过这一条' : `上次 ${last}`) : unusableHint(product);
                return {
                    label: product.label,
                    hint: `${product.id === currentSource ? '当前 · ' : ''}${state}`,
                    value: product.id,
                    disabled: !usable,
                };
            }),
        ],
    });
    return source;
}
/** Update one source's configured model without removing other candidates. */
export function updateFallbackModels(candidates, model, prefer = false) {
    const source = model.split('/')[0];
    const result = [...candidates];
    const index = result.findIndex(value => value.split('/')[0] === source);
    if (index < 0)
        result.push(model);
    else
        result[index] = model;
    return prefer ? [model, ...result.filter(value => value !== model)] : result;
}
/** Build the automatic route from configured accounts and their last models. */
export function configuredFallbackModels(model, lastModels = {}) {
    const chosenSource = model.split('/')[0];
    const available = DEFAULT_FALLBACK_MODELS.filter(value => {
        const source = sourceByName(value.split('/')[0]);
        return source !== undefined && (source.id === chosenSource || usableNow(source));
    }).map(value => {
        const source = value.split('/')[0];
        const last = lastModels[source]?.model;
        return typeof last === 'string' && last.startsWith(`${source}/`) ? last : value;
    });
    return updateFallbackModels(available, model);
}
/** A one-million window is safe only when every configured candidate proves it. */
export function fallbackContextWindow(candidates, lastModels = {}, selected) {
    if (candidates.length === 0)
        return undefined;
    const windows = candidates.map(model => {
        if (selected?.model === model)
            return selected.contextWindow;
        const last = lastModels[model.split('/')[0]];
        return last?.model === model ? last.contextWindow : undefined;
    });
    return windows.every(window => typeof window === 'number' && window >= 1_000_000)
        ? Math.min(...windows)
        : undefined;
}
/** Enable a stable client model with a configurable ordered list of upstream models. */
export async function autoFlow(candidates, selected) {
    const installed = readInstallState();
    const record = bridgeRecord();
    const { port, apiKey } = connectionOf({ record });
    const previousEnv = installed.service?.env ?? record.serviceEnv ?? {};
    if (previousEnv.BRIDGE_MODE === 'gateway') {
        throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'automatic source fallback requires direct mode').withHint('run `fo setup` and configure a direct source first');
    }
    if (!clientConfigIsOurs({ port, file: claudeSettingsPath() })) {
        throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'Claude Code is not configured for this bridge').withHint('run `fo setup` and select Claude Code first');
    }
    const chosen = candidates ?? fallbackOrder(record, previousEnv);
    resolveConfig({ env: {}, argv: ['--fallback', chosen.join(',')] });
    const products = [...new Set([...mountedIds(previousEnv), ...chosen.map(item => item.split('/')[0])])];
    const contextWindow = fallbackContextWindow(chosen, record.lastModels, selected);
    const env = { ...previousEnv, BRIDGE_MODE: 'direct', BRIDGE_FALLBACK_MODELS: chosen.join(',') };
    const applied = await applySwitch({
        port,
        apiKey,
        model: 'auto',
        contextWindow,
        mounted: products,
        env,
        settings: claudeSettingsPath(),
    });
    if (applied.service !== undefined && !applied.service.ok) {
        throw configError(SUBTYPES.SERVICE_UNSUPPORTED, 'the service could not be restarted').withHint(applied.service.reason ?? 'check the service configuration and retry');
    }
    recordBridge({
        port,
        apiKey,
        model: 'auto',
        contextWindow,
        ...(selected === undefined
            ? {}
            : {
                source: selected.model.split('/')[0],
                sourceModel: selected.model,
                sourceContextWindow: selected.contextWindow,
            }),
        serviceEnv: serviceEnvFor({ env, model: 'auto', products }),
    });
    process.stderr.write(`Automatic fallback configured: ${chosen.join(' → ')}\n`);
    if (applied.service === undefined)
        process.stderr.write('Start the foreground bridge using `fo client`.\n');
    return 0;
}
async function chooseAutoFlow() {
    const record = bridgeRecord();
    const env = readInstallState().service?.env ?? record.serviceEnv ?? {};
    const current = fallbackOrder(record, env);
    const action = await select({
        message: '自动回退',
        options: [
            { label: '启用自动回退', hint: `顺序：${current.join(' → ')}`, value: 'enable' },
            { label: '配置回退顺序', hint: '按顺序选择候选模型，可添加或移除', value: 'configure' },
            { label: '返回主菜单', value: 'cancel' },
        ],
    });
    if (action === 'cancel')
        return 0;
    if (action === 'enable')
        return await autoFlow();
    const options = [...current];
    for (const source of SOURCES) {
        if (options.some(model => model.startsWith(`${source.id}/`)))
            continue;
        const remembered = record.lastModels?.[source.id]?.model;
        const fallback = DEFAULT_FALLBACK_MODELS.find(model => model.startsWith(`${source.id}/`));
        const model = remembered?.startsWith(`${source.id}/`)
            ? remembered
            : (fallback ?? (source.kind === 'openai' ? `${source.id}/${source.defaultModel}` : undefined));
        if (model)
            options.push(model);
    }
    note('  按优先级输入编号，未输入的候选项不参与回退；至少选择两项。');
    for (const [index, model] of options.entries())
        note(`  ${index + 1}. ${model}`);
    const selection = await input({
        message: '输入编号（逗号或空格分隔，q 取消）',
        initial: current.map(model => options.indexOf(model) + 1).join(','),
        validate: value => {
            if (value.toLowerCase() === 'q')
                return undefined;
            const parts = value.split(/[,，\s]+/);
            const indexes = parts.map(part => Number(part));
            if (parts.length < 2 || parts.some(part => !/^\d+$/.test(part)) || indexes.some(i => i < 1 || i > options.length))
                return '请输入至少两个有效编号，或输入 q 取消';
            if (new Set(indexes).size !== indexes.length)
                return '编号不能重复';
            return undefined;
        },
    });
    if (selection.toLowerCase() === 'q')
        return 0;
    return await autoFlow(selection.split(/[,，\s]+/).map(value => options[Number(value) - 1]));
}
/**
 * The full `fo use <source>` flow.
 *
 * @param {string} [name] auto or source name; when omitted, show the picker
 */
export async function useFlow(name) {
    // Without an argument the flow opens an arrow-key picker. In a non-TTY context (a script,
    // systemd, `|<pipe>`) no keypress ever arrives, so `select` never settles and the process
    // hangs forever — a script calling bare `fo use` would look like a deadlock rather than a
    // usage error. Fail with the same contract as an unknown name instead.
    if (name === undefined && !isInteractive()) {
        throw validationError(SUBTYPES.MISSING_ARGUMENT, 'no source given')
            .withParam('use')
            .withHint(`pick one of: auto / ${SOURCES.map(source => source.id).join(' / ')}`);
    }
    const choice = name ?? (await chooseSource());
    if (typeof choice === 'string' && choice.trim().toLowerCase() === 'auto')
        return name === undefined ? await chooseAutoFlow() : await autoFlow();
    const source = resolveSource(choice);
    const installed = readInstallState();
    const record = bridgeRecord();
    const { port, apiKey } = connectionOf({ record });
    const env = installed.service?.env ?? record.serviceEnv ?? {};
    if (env.BRIDGE_MODE === 'gateway') {
        throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'currently in gateway mode, where there is no "source" to switch').withHint('to use a Tencent product line / OpenCode instead, run `fo setup` and pick a source');
    }
    if (!usableNow(source)) {
        throw validationError(SUBTYPES.UNKNOWN_SOURCE, `${source.label} is not usable right now`).withHint(unusableHint(source));
    }
    // Progress and results go to stderr (AGENTS.md "output split"): `fo use` is a command
    // scripts call, so stdout is reserved for success data — and there is no data here, only
    // "what is being done".
    const out = (line) => process.stderr.write(`${line}\n`);
    out(`\n${style.bold(`切到 ${source.label}`)}`);
    // The list only supplies the context window and recommendation order; switching proceeds
    // even without it (the model recorded in the ledger is enough).
    // No spinner: `fo use` is a command scripts call, and a spinner writes a `\r` line to
    // stderr every 80ms, turning "switch one source" into hundreds of lines of noise.
    let rows = [];
    try {
        rows = await createDirectUpstream({ products: [source], credentialFile: credentialFile() }, { log: () => { } }).loadModels();
    }
    catch (error) {
        out(`! 拿不到模型清单（${error instanceof Error ? error.message : String(error)}），用上次的模型继续`);
    }
    const lastModels = record.lastModels ?? {};
    const picked = modelForSource({ source, lastModels, rows });
    if (picked.model === undefined) {
        throw configError(SUBTYPES.NO_SOURCES, `${source.label} has no usable default model yet`).withHint(`run \`fo setup\` and pick it, or check the list with \`fo models\``);
    }
    const existing = env.BRIDGE_FALLBACK_MODELS?.split(',').filter(Boolean);
    const candidates = existing?.length ? existing : configuredFallbackModels(picked.model, lastModels);
    if (candidates.length >= 2 && clientConfigIsOurs({ port, file: claudeSettingsPath() })) {
        await autoFlow(updateFallbackModels(candidates, picked.model, true), {
            model: picked.model,
            contextWindow: picked.contextWindow,
        });
        out(`  ${dim('Claude Code keeps the unified auto model; source priority was updated.')}`);
        return 0;
    }
    const apply = await applySwitch({
        port,
        apiKey,
        model: picked.model,
        contextWindow: picked.contextWindow,
        source: source.id,
        mounted: mountedIds(env),
        env,
        settings: claudeSettingsPath(),
    });
    if (apply.service !== undefined && apply.service.ok !== true) {
        throw configError(SUBTYPES.SERVICE_UNSUPPORTED, 'the service could not be restarted').withHint(apply.service.reason ?? 'check the service configuration and retry');
    }
    // The ledger is written last: if any step throws mid-switch, do not leave a half state
    // that records the new model without having written it.
    recordBridge({
        port,
        apiKey,
        model: picked.model,
        contextWindow: picked.contextWindow,
        source: source.id,
        serviceEnv: serviceEnvFor({ env, model: picked.model, products: [...new Set([...mountedIds(env), source.id])] }),
    });
    const model = sizedModelId(picked.model, picked.contextWindow);
    if (!apply.written)
        out(dim('  没动 Claude Code 的配置（按你上次的选择）'));
    out('');
    out(`${style.green('✔')} 已切到 ${source.label}`);
    out(`  ${gray('模型')} ${style.bold(model)}`);
    out(`  ${gray('监听')} http://127.0.0.1:${port}`);
    out(`  ${gray('服务')} ${describeService({ apply, installed, port, apiKey, model: picked.model, env })}`);
    out(dim('  打开一个新的 claude 会话即可生效；接入信息：fo client'));
    out('');
    return 0;
}
/**
 * Which model the service is actually running now.
 *
 * A pit hit on a real machine: the config was written while the service still had the old
 * `BRIDGE_MODEL`, and a single "switched" line in the UI made it look effective. Say
 * honestly "which one is still running" and give the way to reinstall.
 */
function describeService({ apply, installed, port, apiKey, model, env, }) {
    if (installed.service?.path === undefined) {
        return `未常驻（前台跑着的话重启一下：${serveCommandLine(port, apiKey, model, env)}）`;
    }
    if (apply.service?.ok === true)
        return `已重启（${port}）`;
    return `没重启成功：${apply.service?.reason ?? '未知原因'}`;
}
/** A foreground command shown as a hint only; same shape as the one in `fo client`. */
function serveCommandLine(port, apiKey, model, env) {
    const products = [...new Set([...mountedIds(env), model.split('/')[0]])].join(',');
    return `fo serve --port ${port} --api-key ${apiKey} --model ${model} --products ${products}`;
}
/** Which sources are currently mounted; if the ledger has no record, assume all (matching the
 * service's startup default). */
export function mountedIds(env = {}) {
    const recorded = env.BRIDGE_PRODUCTS;
    const listed = typeof recorded === 'string' && recorded.trim() !== ''
        ? recorded
            .split(',')
            .map(name => sourceByName(name))
            .filter(product => product !== undefined)
        : [...SOURCES];
    return listed.map(product => product.id);
}
