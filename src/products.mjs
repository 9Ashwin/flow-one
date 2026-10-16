/**
 * 两个腾讯产品的客户端身份常量。
 *
 * 两条产品线共用同一套 `/plugin` 协议，差异全在这张表里：域名、platform、
 * X-Product-Code、User-Agent、登录 URL 是否需要附加参数。常量取自对官方客户端
 * （CodeBuddy IDE 1.106.1 / WorkBuddy AI 5.5.2）出站报文的实测。
 *
 * ⚠️ User-Agent 不是装饰：国际版后台按模型族分列「使用端」，`glm-*` / `hy*` /
 * `kimi-*` / `minimax-*` 这几条国内模型线要用国内客户端形态发，否则归属显示为 `-`。
 *
 * @module src/products.mjs
 */

/** 国际版：WorkBuddy 自家形态。 */
const UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
/** 国内模型线在国际版域名下使用的客户端形态。 */
const UA_CN_LINE = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/**
 * 国内版 = CodeBuddy（copilot.tencent.com）。
 *
 * 注意品牌：这一条在国内被叫作「WorkBuddy 国内版」，协议里的 X-Product-Code
 * 仍是 `codebuddy`。取名 `cn` 是为了让命令行参数一眼分得清国内与国际。
 */
export const CN = {
  id: 'cn',
  /** 登录方式：oauth = 浏览器授权轮询；none = 无需登录；key = 填 API key。 */
  auth: 'oauth',
  label: 'WorkBuddy 国内版（CodeBuddy）',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  productCode: 'codebuddy',
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
  /** 国内版只有一条产品线，无需按模型分档。 */
  userAgentByModel: [],
  /** 登录 URL 是否要附加 version / loginSessionId（国际版需要）。 */
  sessionParams: false,
  /** 内置兜底模型：远端目录拿不到时至少能用。 */
  fallbackModels: ['deepseek-v4.1-flash', 'hy4-preview-f', 'glm-5.3'],
}

/** 国际版 = WorkBuddy（www.workbuddy.ai）。 */
export const INTL = {
  id: 'intl',
  auth: 'oauth',
  label: 'WorkBuddy 国际版',
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
}

export const PRODUCTS = [CN, INTL]

/** 命令行与模型前缀都接受这些别名，免得用户去猜我们内部的叫法。 */
const ALIASES = new Map([
  ['cn', CN], ['buddy', CN], ['codebuddy', CN], ['国内', CN], ['国内版', CN],
  ['intl', INTL], ['workbuddy', INTL], ['workbuddy-ai', INTL], ['国际', INTL], ['国际版', INTL],
])

/** 未知名字返回 undefined，由调用方给出「可选值有哪些」的报错。 */
export function productByName(name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key === '') return undefined
  return ALIASES.get(key) ?? ALIASES.get(String(name).trim())
}

export const PRODUCT_NAMES = 'cn（国内版 CodeBuddy） / intl（国际版 WorkBuddy）'

/**
 * 按模型族挑 User-Agent；没有命中规则时用产品默认档。
 *
 * 前缀匹配是有意的：规则表里的 `hy` 要能同时命中 `hy3` / `hy4-preview-f`。
 */
export function userAgentFor(product, model) {
  for (const [prefix, ua] of product.userAgentByModel) {
    if (String(model).startsWith(prefix)) return ua
  }
  return product.userAgent
}
