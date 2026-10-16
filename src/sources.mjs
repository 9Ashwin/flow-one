/**
 * 「来源」注册表：一个进程里可以同时挂哪些上游。
 *
 * 两种来源，形状不同但对外接口一致：
 *
 * - **腾讯产品**（`cn` 国内版 / `intl` 国际版）：要先登录，走 `/v2/chat/completions`；
 * - **OpenCode 免费档**（`oc`）：无需登录（匿名 `Bearer public`），走 OpenAI 形状的
 *   `/inference/v1/chat/completions`，但报文必须凑齐 FreeTier 门禁要求的形状。
 *
 * 模型 ID 一律带来源前缀（`cn/…`、`intl/…`、`oc/…`），所以「换个模型」就等于换个
 * 来源，一个进程服务全部。
 *
 * @module src/sources.mjs
 */

import { CN, INTL } from './products.mjs'
import { OPENCODE, OPENCODE_GO, hasGoCredential } from './opencode.mjs'

export const SOURCES = [CN, INTL, OPENCODE, OPENCODE_GO]

/**
 * 默认挂载哪些来源。
 *
 * 要 key 的来源（OpenCode Go）**没配 key 就不挂** —— 挂了也只是每次启动多一条
 * 「模型清单不可用」的噪声，还容易让人以为服务坏了。
 */
export const defaultSources = () => SOURCES.filter(source => source.auth !== 'key' || hasGoCredential())

/** 命令行、模型前缀、向导都认这些别名，省得用户去猜内部叫法。 */
const ALIASES = new Map([
  ['cn', CN], ['buddy', CN], ['codebuddy', CN], ['国内', CN], ['国内版', CN],
  ['intl', INTL], ['workbuddy', INTL], ['workbuddy-ai', INTL], ['国际', INTL], ['国际版', INTL],
  ['oc', OPENCODE], ['opencode', OPENCODE], ['免费', OPENCODE], ['免费档', OPENCODE],
  ['ocg', OPENCODE_GO], ['opencode-go', OPENCODE_GO], ['opencodego', OPENCODE_GO],
  ['go', OPENCODE_GO], ['套餐', OPENCODE_GO], ['go套餐', OPENCODE_GO],
])

/** 未知名字返回 undefined，由调用方列出可选值报错。 */
export function sourceByName(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return undefined
  return ALIASES.get(raw.toLowerCase()) ?? ALIASES.get(raw)
}

export const SOURCE_NAMES = SOURCES.map(source => `${source.id}（${source.label}）`).join(' / ')

/** 需要凭据的来源（向导据此决定要不要走登录：腾讯是浏览器授权，Go 套餐是填 key）。 */
export const needsLogin = source => source.auth !== 'none'
