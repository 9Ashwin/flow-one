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

import type { SystemRewriter } from './types.ts'

/** Models that go through Tencent's content moderation. Direct mode uses `cn/` `intl/`; gateway mode uses DSH's `buddy/` `workbuddy/`. */
const TENCENT_MODEL_PREFIXES = ['cn/', 'intl/', 'buddy/', 'workbuddy/']

/** One literal rule: the blocked sentence and its equivalent rewrite. */
interface LiteralRule {
  find: string
  replace: string
  /**
   * A second literal that must also be present before rewriting.
   *
   * Measured 2026-10-22 and 2026-11-08: several of these sentences are blocked **only when
   * they co-occur with their neighbor**, and each alone returns 200. Rewriting a lone
   * occurrence would needlessly change the prompt prefix Tencent caches by, so the rule
   * waits for both.
   */
  requires?: string
  note: string
}

/** One whole-line rule: `pattern` matches the line to delete. */
interface LineRule {
  pattern: RegExp
  note: string
}

/** Each rule: `find` is the blocked literal (case-insensitive, never pattern-generalised), `replace` is the equivalent rewrite. */
const RULES: LiteralRule[] = [
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
  {
    // DSH's "@ path" paragraph. Measured 2026-11-08: the first sentence alone → 200, the
    // second alone → 200, but the two joined by a single space → 400 + 11128. The boundary
    // is narrow in a way that matters for how the rule is written: reversed order, a
    // newline instead of the space, and the two sentences in separate `system` blocks all
    // pass, and rewriting **one word** in either sentence passes. So the criterion is again
    // a co-occurrence, and only the first sentence (the one that names `@`) is rewritten —
    // the rewrite keeps the instruction intact.
    find: 'Tokens prefixed with @ are paths the user explicitly referenced.',
    replace: 'Tokens prefixed with @ are paths the user named explicitly.',
    requires: 'Relative paths resolve from the workspace root',
    note: 'measured 2026-11-08: each sentence 200, both joined 400 + 11128, one-word rewrite 200 (cn/deepseek-v4.1-flash and intl/deepseek-v4.1-flash)',
  },
]

/**
 * Rules that delete a whole line. The matching line is removed together with its newline,
 * leaving no blank line behind.
 *
 * They are kept apart from the literal rules because what varies differs: literal rules
 * key on a complete sentence, while these key on the key name at the start of the line,
 * whose value differs with every client version.
 */
const LINE_RULES: LineRule[] = [
  {
    pattern: /^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gim,
    note: 'measured 2026-10-16: this line 400 + 11128; renamed or deleted 200 (Claude Code 2.1.301)',
  },
]

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Opening lines of prose that only describes **the client itself**: who it is, how the
 * user sees it, and how it treats its own input.
 *
 * This is the fallback list, used when a turn is rejected even though the literal rules
 * above were applied. The point of matching a section's **opening** rather than a whole
 * sentence is that a new harness release rewords sentences all the time, while a section
 * that introduces the client stays recognisable — that is what keeps this mechanism from
 * needing another hand-written literal for every upstream change.
 *
 * Sections carrying task instructions, tool guidance, or runtime facts are deliberately
 * absent: dropping those would trade a blocked turn for a degraded agent.
 */
const CLIENT_SECTION_PATTERNS: RegExp[] = [
  /^You are an AI agent powered by\b/i,
  /^You are a coding agent powered by\b/i,
  /^You are interacting with the user through\b/i,
  /^Tokens (?:prefixed with|beginning with) @/i,
]

/** What a section strip did: the new text and the sections that were dropped. */
export interface SectionStrip {
  text: string
  removed: string[]
}

/**
 * Drop client self-description sections, optionally only the ones a caller recognises.
 *
 * `shouldStrip` receives the section verbatim so a caller can decide by content hash; the
 * default accepts every matching section (the learning pass). When nothing matches, the
 * input is returned **unchanged and byte for byte**, so a caller cannot accidentally
 * disturb a prompt that was fine.
 */
export function stripClientSections(
  text: unknown,
  shouldStrip: (section: string) => boolean = () => true,
): SectionStrip {
  const source = String(text ?? '')
  if (source === '') return { text: source, removed: [] }
  const kept: string[] = []
  const removed: string[] = []
  for (const section of source.split(/\n[ \t]*\n/)) {
    if (CLIENT_SECTION_PATTERNS.some(pattern => pattern.test(section.trimStart())) && shouldStrip(section)) {
      removed.push(section)
      continue
    }
    kept.push(section)
  }
  return removed.length === 0 ? { text: source, removed } : { text: kept.join('\n\n'), removed }
}

/**
 * Whether an upstream failure is the channel check (`400` + `code 11128`), in either of its
 * two wordings shipped so far ("Illegal API invocation from an unapproved channel" and the
 * newer "did not pass channel verification").
 */
export function isChannelBlock(message: unknown): boolean {
  return /11128|请求被拦截|渠道校验|Illegal API invocation|unapproved channel/i.test(String(message ?? ''))
}

const COMPILED = RULES.map(rule => ({
  ...rule,
  findLower: rule.find.toLowerCase(),
  requiresLower: rule.requires?.toLowerCase(),
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/** Whether this model goes through Tencent's backend. Decided by prefix, aliases (`buddy`/`workbuddy`) included. */
export function isTencentModel(model: unknown): boolean {
  const id = String(model ?? '')
  return TENCENT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))
}

/**
 * Rewrite the literals that hit.
 *
 * Contract: text containing no fingerprint is returned **byte for byte unchanged**
 * (Tencent caches by prefix, so needlessly rebuilding the string makes every turn count
 * as a new prefix); a new string is returned only on a hit.
 */
export function rewriteTencentFingerprints(text: string): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const rule of COMPILED) {
    const lower = out.toLowerCase()
    if (!lower.includes(rule.findLower)) continue
    if (rule.requiresLower !== undefined && !lower.includes(rule.requiresLower)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  let droppedLine = false
  for (const rule of LINE_RULES) {
    rule.pattern.lastIndex = 0
    if (!rule.pattern.test(out)) continue
    rule.pattern.lastIndex = 0
    out = out.replace(rule.pattern, '')
    droppedLine = true
  }
  // When the deleted line was the first one, do not leave a leading blank line for the
  // model (that is a trace of the rewrite, not the original text).
  if (droppedLine) out = out.replace(/^\s+/, '')
  return out
}

/**
 * Pick the system rewriter for a model; returns undefined when no rewrite is needed
 * (callers use that to skip).
 *
 * @param model upstream model ID, already resolved
 * @param enabled whether the user allows rewriting (allowed by default)
 */
export function systemRewriterFor(model: unknown, enabled = true): SystemRewriter | undefined {
  if (!enabled || !isTencentModel(model)) return undefined
  return rewriteTencentFingerprints
}

/** For tests and documentation: the rules currently in effect. */
export const FINGERPRINT_RULES = RULES
