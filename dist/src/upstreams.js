// Upstream adapters: collapse "a gateway" and "the Tencent products you log into" into
// one interface.
//
// ```js
// upstream.listModels()            → [{ id, ... }]      catalogue (IDs already carry the product prefix)
// upstream.chat(body, { signal })  → { ok: true, chunks } | { ok: false, status, message }
// ```
//
// `chat`'s `chunks` are always **OpenAI chunks**. Both upstreams speak the same wire
// format already (Tencent's `/v2/chat/completions` is OpenAI-shaped), so the Anthropic
// translation layer accepts one input and never needs to know which upstream answered.
import { chat as buddyChat, listModels as buddyListModels } from "./buddy.js";
import { ensureCredential } from "./auth.js";
import { sourceByName } from "./sources.js";
import { failureOf, readSse } from "./sse.js";
import { chat as opencodeChat, listModels as opencodeListModels } from "./opencode.js";
const MODEL_TTL_MS = 60_000;
function authHeaders(key) {
    return {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
    };
}
/** Any OpenAI-compatible endpoint: DSH's channel gateway, Ollama, vLLM, an official API… */
export function createGatewayUpstream(config) {
    async function loadModels() {
        const response = await fetch(`${config.upstream}/v1/models`, {
            headers: authHeaders(config.upstreamKey),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`upstream model catalogue failed (HTTP ${response.status})`);
        const payload = (await response.json());
        return (Array.isArray(payload.data) ? payload.data : [])
            .filter(row => typeof row?.id === 'string' && row.id !== '')
            .map(row => {
            const reasoning = (row.reasoning !== null && typeof row.reasoning === 'object' ? row.reasoning : {});
            return {
                id: row.id,
                name: typeof row.name === 'string' ? row.name : row.id,
                // Some gateways include these in their catalogue; others just
                // leave them out.
                ...(typeof row.context_window === 'number' ? { contextWindow: row.context_window } : {}),
                ...(typeof row.max_tokens === 'number' ? { maxOutputTokens: row.max_tokens } : {}),
                ...(Array.isArray(row.input) ? { supportsImages: row.input.includes('image') } : {}),
                ...(Array.isArray(reasoning.openai_efforts)
                    ? { efforts: reasoning.openai_efforts.filter((item) => typeof item === 'string') }
                    : {}),
            };
        });
    }
    return {
        name: 'gateway',
        describe: () => `gateway ${config.upstream}`,
        loadModels,
        async chat(body, { signal } = {}) {
            const response = await fetch(`${config.upstream}/v1/chat/completions`, {
                method: 'POST',
                headers: authHeaders(config.upstreamKey),
                body: JSON.stringify({ ...body, stream: true }),
                signal,
            });
            if (!response.ok)
                return failureOf(response);
            return { ok: true, chunks: readSse(asStream(response.body), true) };
        },
    };
}
/** `fetch` types the body as nullable; a 2xx SSE response always has one. */
function asStream(body) {
    if (body === null)
        throw new Error('the upstream returned a 2xx response without a body');
    return body;
}
/**
 * Self-authenticated Tencent products plus the anonymous OpenCode free tier.
 *
 * Model IDs always carry a source prefix (`cn/…`, `intl/…`, `oc/…`), so **one
 * process serves every line at once**: changing `ANTHROPIC_MODEL` in Claude Code
 * changes the source.
 */
export function createDirectUpstream(config, { log = () => { } } = {}) {
    const products = config.products;
    const meta = new Map();
    let cached = [];
    let cachedAt = 0;
    let loading;
    const productFor = (id) => {
        const raw = String(id);
        const at = raw.indexOf('/');
        if (at < 0)
            return { product: products[0], model: raw };
        // Look among the products mounted in this process first, then fall back to the
        // alias table: tests and custom products use local endpoints, and going straight
        // to the alias table resolves to the built-in product constants, so the prefix
        // cannot be stripped.
        const named = products.find(item => item.id === raw.slice(0, at)) ?? sourceByName(raw.slice(0, at));
        if (named === undefined || !products.includes(named))
            return { product: products[0], model: raw };
        return { product: named, model: raw.slice(at + 1) };
    };
    async function loadAll() {
        const groups = await Promise.all(products.map(async (product) => {
            try {
                const models = product.kind === 'openai'
                    ? await opencodeListModels(product)
                    : await buddyListModels(product, await ensureCredential(product, { log, file: config.credentialFile }), {
                        log,
                    });
                return models.map(model => {
                    meta.set(`${product.id}/${model.id}`, model);
                    return { ...model, id: `${product.id}/${model.id}`, name: model.name ?? model.id, product: product.id };
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`${product.label}: model catalogue unavailable — ${message}`);
                return [];
            }
        }));
        return groups.flat();
    }
    async function loadModels() {
        if (Date.now() - cachedAt < MODEL_TTL_MS && cached.length > 0)
            return cached;
        if (loading !== undefined)
            return loading;
        loading = loadAll()
            .then(rows => {
            cached = rows;
            cachedAt = Date.now();
            return rows;
        })
            .finally(() => {
            loading = undefined;
        });
        return loading;
    }
    return {
        name: 'direct',
        describe: () => `direct ${products.map(product => product.label).join(' + ')}`,
        loadModels,
        async chat(body, { signal } = {}) {
            const { product, model } = productFor(String(body.model ?? ''));
            // A failure is tagged with the source that produced it: with several mounted
            // sources a bare "401" never says which line is broken.
            if (product.kind === 'openai') {
                const result = await opencodeChat(product, model, body, { signal, log });
                return result.ok
                    ? result
                    : { ...result, attempts: [{ upstream: product.id, status: result.status, message: result.message }] };
            }
            const result = await buddyChat(product, { ...body, model: undefined }, {
                model,
                meta: meta.get(`${product.id}/${model}`),
                signal,
                log,
                file: config.credentialFile,
            });
            if (!result.ok)
                return { ...result, attempts: [{ upstream: product.id, status: result.status, message: result.message }] };
            // In-stream policy blocks arrive as "HTTP 200 plus one {code,msg} frame" with no
            // `choices`; a content frame always carries `choices`, which is the signal used
            // to turn the former into a uniform chunk-level error.
            const chunks = readSse(asStream(result.response.body), true);
            return { ok: true, chunks: rejectInStream(chunks, product) };
        },
    };
}
/** Turn an in-stream error frame such as `{code:11140,...}` into `{error:{message}}` for the translator. */
async function* rejectInStream(chunks, product) {
    for await (const chunk of chunks) {
        const record = (chunk !== null && typeof chunk === 'object' ? chunk : {});
        const hasChoices = Object.hasOwn(record, 'choices');
        const code = record.code;
        if (!hasChoices && (typeof code === 'number' || typeof record.msg === 'string')) {
            const message = record.msg ?? record.message ?? record.displayMsg ?? `code ${String(code)}`;
            yield { error: { message: `${product.label}: ${typeof code === 'number' ? `${code} ` : ''}${String(message)}` } };
            return;
        }
        yield chunk;
    }
}
