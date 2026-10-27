// The "source" registry: which upstreams one process can mount at the same time.
//
// Two kinds of source, different shapes but one interface:
//
// - **Tencent products** (`cn` domestic / `intl` international): log in first, call
//   `/v2/chat/completions`;
// - **The OpenCode free tier** (`oc`): no login (anonymous `Bearer public`), calls the
//   OpenAI-shaped `/inference/v1/chat/completions`, but the payload must satisfy the
//   shape the FreeTier gate requires.
//
// Model IDs always carry the source prefix (`cn/…`, `intl/…`, `oc/…`), so "switch model"
// means "switch source", and one process serves them all.
import { CN, INTL } from "./products.js";
import { OPENCODE, OPENCODE_GO, hasGoCredential } from "./opencode.js";
export const SOURCES = [CN, INTL, OPENCODE, OPENCODE_GO];
/**
 * Which sources are mounted by default.
 *
 * A source that needs a key (OpenCode Go) is **not mounted without one**: mounting it
 * only adds a "model catalogue unavailable" line on every start, and makes people think
 * the service is broken.
 */
export const defaultSources = () => SOURCES.filter(source => source.auth !== 'key' || hasGoCredential());
/**
 * The command line, model prefixes and the wizard all accept these aliases, so users
 * need not guess our internal naming. The Chinese aliases are literal user input, not
 * display text.
 */
const ALIASES = new Map([
    ['cn', CN],
    ['buddy', CN],
    ['codebuddy', CN],
    ['国内', CN],
    ['国内版', CN],
    ['intl', INTL],
    ['workbuddy', INTL],
    ['workbuddy-ai', INTL],
    ['国际', INTL],
    ['国际版', INTL],
    ['oc', OPENCODE],
    ['opencode', OPENCODE],
    ['免费', OPENCODE],
    ['免费档', OPENCODE],
    ['ocg', OPENCODE_GO],
    ['opencode-go', OPENCODE_GO],
    ['opencodego', OPENCODE_GO],
    ['go', OPENCODE_GO],
    ['套餐', OPENCODE_GO],
    ['go套餐', OPENCODE_GO],
]);
/** An unknown name returns undefined; the caller reports which values are available. */
export function sourceByName(name) {
    const raw = String(name ?? '').trim();
    if (raw === '')
        return undefined;
    return ALIASES.get(raw.toLowerCase()) ?? ALIASES.get(raw);
}
export const SOURCE_NAMES = SOURCES.map(source => `${source.id} (${source.label})`).join(' / ');
/** Sources that need a credential: the wizard decides whether to log in (Tencent uses
 * browser authorisation, the Go plan wants a key). */
export const needsLogin = (source) => source.auth !== 'none';
