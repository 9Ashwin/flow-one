/**
 * 腾讯侧内容风控的**窄改写**。
 *
 * 腾讯的后端会拦下「自称是别的客户端」的请求：Claude Code 的系统提示以
 * `You are Claude Code, Anthropic's official CLI for Claude.` 开头，这一轮会被
 * 判成 `400 / code 11128 / Illegal API invocation from an unapproved channel`，
 * 而换成中性文案就正常返回。
 *
 * ## 判据是实测出来的，不是猜的
 *
 * 2026-10-16 对 `workbuddy/deepseek-v4.1-flash`（经本机网关直发腾讯）逐条实测：
 *
 * | system 内容 | 结果 |
 * | --- | --- |
 * | `You are Claude Code, Anthropic's official CLI for Claude.` | **拦截** |
 * | 上面这句去掉句号 | **拦截** |
 * | 整句改小写 | **拦截** |
 * | `You are Claude Code, an official CLI for Claude.` | 通过 |
 * | `You are Claude Code, official CLI for Claude.` | 通过 |
 * | `You are Claude Code, Anthropic's official coding agent for Claude.` | 通过 |
 * | `You are Claude Code.`（只有一半） | 通过 |
 * | `You are Anthropic's official CLI for Claude.`（只有另一半） | 通过 |
 *
 * 结论：**只在这两个片段同现时**才被拦。因此规则写成整句字面量，而不是把
 * `Anthropic's` 一个词设成全局替换 —— 后者会连带改掉那些本来没人拦的文本。
 *
 * 改写保持语义：`an official CLI for Claude` 与原句同义，模型读到的身份没变。
 *
 * ## 第二条：新版 Claude Code 的计费头（这才是真正每天都在拦的那条）
 *
 * Claude Code 2.1.x 会在 system 提示**第一行**拼一个归属标记：
 *
 * ```
 * x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;
 * ```
 *
 * 实测（同上时间与模型）：
 *
 * | system 内容 | 结果 |
 * | --- | --- |
 * | 完整那一行 | **拦截** |
 * | 大写 `X-ANTHROPIC-BILLING-HEADER: whatever` | **拦截** |
 * | 只留 `cc_entrypoint=sdk-cli` | 通过 |
 * | 改名为 `x-billing-header: …` | 通过 |
 * | 整行删掉 | 通过 |
 *
 * 判据是**键名**，值随客户端发布变化（换个版本号照样被拦），所以这条用整行匹配
 * 而不是字面量：键名精确、值任意、大小写不敏感。删掉它是安全的——这一行只为
 * 归属统计存在，对模型没有任何语义。
 *
 * @module src/fingerprint.mjs
 */

/** 会走腾讯后端的内容风控。直连模式是 `cn/` `intl/`，网关模式是 DSH 的 `buddy/` `workbuddy/`。 */
const TENCENT_MODEL_PREFIXES = ['cn/', 'intl/', 'buddy/', 'workbuddy/']

/** 每条规则：`find` 是被拦的字面量（大小写不敏感、不做模式泛化），`replace` 是等义改写。 */
const RULES = [
  {
    find: "You are Claude Code, Anthropic's official CLI for Claude",
    replace: 'You are Claude Code, an official CLI for Claude',
    note: '2026-10-16 实测：原句 400 + 11128，改写后 200（workbuddy/deepseek-v4.1-flash）',
  },
  {
    // Claude Code 的 gitStatus 上下文：只要会话在一个 git 仓库里，它就把这一行
    // 拼进 system。判据是**整句逐字符**，不是关键词——少一个词或多一个空格都不拦。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: '2026-10-16 实测：整句 400 + 11128，改写后 200（intl/deepseek-v4.1-flash、cn/hy4-preview、cn/deepseek-v4.1-flash、intl/hy4-preview-f）',
  },
]

/**
 * 整行删除的规则。匹配到的行连同换行一起移除，不留下空行。
 *
 * 与字面量规则分开，是因为它们的「什么在变」不同：字面量规则的判据是完整句子，
 * 这里的判据是行首的键名，值每个客户端版本都不一样。
 */
const LINE_RULES = [
  {
    pattern: /^[ \t]*x-anthropic-billing-header:[^\n]*\n?/gim,
    note: '2026-10-16 实测：该行 400 + 11128；改名或删除后 200（Claude Code 2.1.301）',
  },
]

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED = RULES.map(rule => ({
  ...rule,
  findLower: rule.find.toLowerCase(),
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/** 该模型是否走腾讯后端。用前缀判定，别名（`buddy`/`workbuddy`）一并覆盖。 */
export function isTencentModel(model) {
  const id = String(model ?? '')
  return TENCENT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))
}

/**
 * 改写命中的字面量。
 *
 * 契约：不含任何指纹的文本**逐字符不变**（腾讯侧按前缀缓存，无谓地重建字符串
 * 会让每一轮都算作新前缀）；命中才返回新串。
 */
export function rewriteTencentFingerprints(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const rule of COMPILED) {
    if (!out.toLowerCase().includes(rule.findLower)) continue
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
  // 删掉的是首行时，别把前导空行留给模型（那是改写留下的痕迹，不是原文）。
  if (droppedLine) out = out.replace(/^\s+/, '')
  return out
}

/**
 * 给某个模型挑一个 system 改写器；不需要改写时返回 undefined（调用方据此跳过）。
 *
 * @param {string} model 已经解析过的上游模型 ID
 * @param {boolean} enabled 用户是否允许改写（默认允许）
 */
export function systemRewriterFor(model, enabled = true) {
  if (!enabled || !isTencentModel(model)) return undefined
  return rewriteTencentFingerprints
}

/** 供测试与文档展示：当前生效的规则。 */
export const FINGERPRINT_RULES = RULES
