// Client identity constants for the two Tencent products.
//
// Both product lines share the same `/plugin` protocol; every difference lives in
// this table: domain, platform, X-Product-Code, User-Agent, and whether the login
// URL needs extra parameters. The constants are measured from the outbound
// traffic of the official clients (CodeBuddy IDE 1.106.1 / WorkBuddy AI 5.5.2).
//
// ⚠️ User-Agent is not decoration: the international backend breaks "usage
// endpoint" down by model family, and the domestic model lines `glm-*` / `hy*` /
// `kimi-*` / `minimax-*` must be sent with the domestic client shape, or
// attribution shows as `-`.
/** International: WorkBuddy's own shape. */
const UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2';
/** The client shape domestic model lines use under the international domain. */
const UA_CN_LINE = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2';
/**
 * Domestic = CodeBuddy (copilot.tencent.com).
 *
 * Mind the branding: inside China this line is called "WorkBuddy domestic", while
 * the protocol's X-Product-Code is still `codebuddy`. It is named `cn` so that a
 * command-line argument tells domestic and international apart at a glance.
 */
export const CN = {
    id: 'cn',
    /** Login method: oauth = browser authorisation polling; none = no login; key = supply an API key. */
    auth: 'oauth',
    label: 'WorkBuddy domestic (CodeBuddy)',
    platform: 'ide',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    productCode: 'codebuddy',
    attributionName: 'CodeBuddy',
    clientVersion: '1.106.1',
    userAgent: 'CodeBuddyIDE/1.106.1',
    /** The domestic product has a single line, so no per-model variant. */
    userAgentByModel: [],
    /** Whether the login URL needs version / loginSessionId appended (the international one does). */
    sessionParams: false,
    /** Built-in fallback models: at least these work when the remote catalogue is unavailable. */
    fallbackModels: ['deepseek-v4.1-flash', 'hy4-preview-f', 'glm-5.3'],
};
/** International = WorkBuddy (www.workbuddy.ai). */
export const INTL = {
    id: 'intl',
    auth: 'oauth',
    label: 'WorkBuddy international',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    productCode: 'workbuddy',
    attributionName: 'WorkBuddy',
    clientVersion: '5.5.2',
    userAgent: UA_INTL,
    userAgentByModel: [
        ['gpt-', UA_INTL],
        ['gemini-', UA_INTL],
        ['claude-', UA_INTL],
        ['glm-', UA_CN_LINE],
        ['hy', UA_CN_LINE],
        ['kimi-', UA_CN_LINE],
        ['minimax-', UA_CN_LINE],
    ],
    sessionParams: true,
    pluginVersion: '5.5.2',
    fallbackModels: ['default-model', 'fast-model', 'hy4-preview-f', 'deepseek-v4.1-flash'],
};
export const PRODUCTS = [CN, INTL];
/**
 * Command line and model prefixes accept these aliases, so users need not guess our
 * internal naming. The Chinese aliases are accepted verbatim on purpose: they are
 * literal user input (`fo login 国内版`), not display text.
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
]);
/** An unknown name returns undefined; the caller reports which values are available. */
export function productByName(name) {
    const key = String(name ?? '')
        .trim()
        .toLowerCase();
    if (key === '')
        return undefined;
    return ALIASES.get(key) ?? ALIASES.get(String(name).trim());
}
export const PRODUCT_NAMES = 'cn (domestic CodeBuddy) / intl (international WorkBuddy)';
/**
 * Pick the User-Agent by model family; when no rule matches, the product default applies.
 *
 * Prefix matching is intentional: the `hy` rule must also match `hy3` / `hy4-preview-f`.
 */
export function userAgentFor(product, model) {
    for (const [prefix, ua] of product.userAgentByModel) {
        if (String(model).startsWith(prefix))
            return ua;
    }
    return product.userAgent;
}
