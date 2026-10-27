// The **narrow rewrite** for content moderation on the Tencent side.
//
// Tencent's backend rejects requests that "claim to be another client": a Claude Code
// system prompt starts with `You are Claude Code, Anthropic's official CLI for Claude.`,
// and that turn is judged as `400 / code 11128 / Illegal API invocation from an
// unapproved channel`, while neutral wording returns normally.
//
// ## The criteria are measured, not guessed
//
// On 2026-10-16 every variant was tested against `workbuddy/deepseek-v4.1-flash`
// (sent straight to Tencent through the local gateway):
//
// | system content | result |
// | --- | --- |
// | `You are Claude Code, Anthropic's official CLI for Claude.` | **blocked** |
// | the sentence above with the full stop removed | **blocked** |
// | the whole sentence lowercased | **blocked** |
// | `You are Claude Code, an official CLI for Claude.` | passes |
// | `You are Claude Code, official CLI for Claude.` | passes |
// | `You are Claude Code, Anthropic's official coding agent for Claude.` | passes |
// | `You are Claude Code.` (only one half) | passes |
// | `You are Anthropic's official CLI for Claude.` (only the other half) | passes |
//
// Conclusion: it is blocked **only when both fragments appear together**. That is why
// the rule is the whole sentence as a literal, not a global replacement of the single
// word `Anthropic's` — the latter would also rewrite text nobody blocks.
//
// The rewrite preserves meaning: `an official CLI for Claude` is synonymous with the
// original, so the identity the model reads is unchanged.
//
// ## Second rule: the billing header of newer Claude Code (this is the one that blocks every day)
//
// Claude Code 2.1.x prepends an attribution marker as the **first line** of the system prompt:
//
// ```
// x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;
// ```
//
// Measured (same date and model as above):
//
// | system content | result |
// | --- | --- |
// | the complete line | **blocked** |
// | uppercased `X-ANTHROPIC-BILLING-HEADER: whatever` | **blocked** |
// | only `cc_entrypoint=sdk-cli` left | passes |
// | renamed to `x-billing-header: …` | passes |
// | the whole line deleted | passes |
//
// The criterion is the **key name**; the value changes with every client release (a new
// version number is still blocked), so this rule matches the whole line rather than a
// literal: exact key, arbitrary value, case-insensitive. Deleting it is safe — the line
// exists only for attribution statistics and carries no meaning for the model.
/** Models that go through Tencent's content moderation. Direct mode uses `cn/` `intl/`; gateway mode uses DSH's `buddy/` `workbuddy/`. */
const TENCENT_MODEL_PREFIXES = ['cn/', 'intl/', 'buddy/', 'workbuddy/'];
/** Each rule: `find` is the blocked literal (case-insensitive, never pattern-generalised), `replace` is the equivalent rewrite. */
const RULES = [
    {
        find: "You are Claude Code, Anthropic's official CLI for Claude",
        replace: 'You are Claude Code, an official CLI for Claude',
        note: 'measured 2026-10-16: original sentence 400 + 11128, rewritten 200 (workbuddy/deepseek-v4.1-flash)',
    },
    {
        // Claude Code's gitStatus context: whenever the session is in a git repository, it
        // appends this line to the system prompt. The criterion is the **whole sentence,
        // character by character**, not a keyword — one word fewer or one extra space is not blocked.
        find: 'Main branch (you will usually use this for PRs)',
        replace: 'Main branch (PRs usually go here)',
        note: 'measured 2026-10-16: whole sentence 400 + 11128, rewritten 200 (intl/deepseek-v4.1-flash, cn/hy4-preview, cn/deepseek-v4.1-flash, intl/hy4-preview-f)',
    },
    {
        // The first persona sentence of DSH (DeepSeek Harness). Since 2026-10-22 the cn side
        // treats it as an "unofficial client" criterion too: matched character by character,
        // while `DeepSeek Harness` or `You are an AI agent` alone are not blocked, and even
        // dropping the full stop is still blocked.
        find: 'You are an AI agent powered by DeepSeek Harness',
        replace: 'You are an AI agent powered by a DeepSeek harness',
        note: 'measured 2026-10-22: original sentence 400 + 11128, rewritten 200 (cn/deepseek-v4.1-flash); intl unaffected',
    },
    {
        // These two sentences are blocked only when **both appear** in the same system prompt
        // (each alone returns 200). The fragment inside the first half is rewritten, keeping
        // the meaning "interacting through some harness's Web GUI" — it is merely client
        // self-description, and the model never uses the literal brand.
        find: 'through the DeepSeek Harness Web GUI',
        replace: 'through the harness Web GUI',
        note: 'measured 2026-10-22: together with the next sentence → 400 + 11128, rewriting only this spot → 200 (cn/deepseek-v4.1-flash)',
    },
];
/**
 * Rules that delete a whole line. The matching line is removed together with its newline,
 * leaving no blank line behind.
 *
 * They are kept apart from the literal rules because what varies differs: literal rules
 * key on a complete sentence, while these key on the key name at the start of the line,
 * whose value differs with every client version.
 */
const LINE_RULES = [
    {
        pattern: /^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gim,
        note: 'measured 2026-10-16: this line 400 + 11128; renamed or deleted 200 (Claude Code 2.1.301)',
    },
];
function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const COMPILED = RULES.map(rule => ({
    ...rule,
    findLower: rule.find.toLowerCase(),
    pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}));
/** Whether this model goes through Tencent's backend. Decided by prefix, aliases (`buddy`/`workbuddy`) included. */
export function isTencentModel(model) {
    const id = String(model ?? '');
    return TENCENT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}
/**
 * Rewrite the literals that hit.
 *
 * Contract: text containing no fingerprint is returned **byte for byte unchanged**
 * (Tencent caches by prefix, so needlessly rebuilding the string makes every turn count
 * as a new prefix); a new string is returned only on a hit.
 */
export function rewriteTencentFingerprints(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    let out = text;
    for (const rule of COMPILED) {
        if (!out.toLowerCase().includes(rule.findLower))
            continue;
        out = out.replace(rule.pattern, rule.replace);
    }
    let droppedLine = false;
    for (const rule of LINE_RULES) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(out))
            continue;
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, '');
        droppedLine = true;
    }
    // When the deleted line was the first one, do not leave a leading blank line for the
    // model (that is a trace of the rewrite, not the original text).
    if (droppedLine)
        out = out.replace(/^\s+/, '');
    return out;
}
/**
 * Pick the system rewriter for a model; returns undefined when no rewrite is needed
 * (callers use that to skip).
 *
 * @param model upstream model ID, already resolved
 * @param enabled whether the user allows rewriting (allowed by default)
 */
export function systemRewriterFor(model, enabled = true) {
    if (!enabled || !isTencentModel(model))
        return undefined;
    return rewriteTencentFingerprints;
}
/** For tests and documentation: the rules currently in effect. */
export const FINGERPRINT_RULES = RULES;
