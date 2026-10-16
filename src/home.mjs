/**
 * 数据目录位置。
 *
 * 单独成模块是为了**打断循环依赖**：`config.mjs` 要用「来源表」，而来源表里的
 * OpenCode 客户端要用数据目录 —— 三者一旦互相 import 就会在 ESM 下触发 TDZ
 * （`Cannot access 'OPENCODE' before initialization`）。这里什么都不 import，
 * 谁都可以安全地依赖它。
 *
 * @module src/home.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 数据目录名。 */
export const HOME_DIR = '.flow-one'
/** 改名（claude-code-openai-bridge → flow-one）之前的目录名。 */
export const LEGACY_HOME_DIR = '.claude-code-openai-bridge'

/**
 * 数据目录：`BRIDGE_HOME` 优先，否则 `~/.flow-one`。
 *
 * 改名不能把已有登录态弄丢 —— 凭据（腾讯两条线的登录态 + OpenCode Go 的 key）
 * 就躺在旧目录里。所以**新目录不存在而旧目录存在时继续用旧的**：改名对老用户是无感的，
 * 想搬就自己 `mv` 过去（`fo status` 会提示一次，但不替你动凭据）。
 */
export function bridgeHome(env = process.env, home = os.homedir()) {
  const override = String(env.BRIDGE_HOME ?? '').trim()
  if (override !== '') return path.resolve(override)
  const current = path.join(home, HOME_DIR)
  if (fs.existsSync(current) || !fs.existsSync(path.join(home, LEGACY_HOME_DIR))) return current
  return path.join(home, LEGACY_HOME_DIR)
}

/** 报告当前用的还是改名前的旧目录（status / doctor 据此提示怎么搬）。 */
export function legacyHomeInUse(env = process.env, home = os.homedir()) {
  if (String(env.BRIDGE_HOME ?? '').trim() !== '') return false
  return !fs.existsSync(path.join(home, HOME_DIR)) && fs.existsSync(path.join(home, LEGACY_HOME_DIR))
}

export function credentialFile(env = process.env, home = os.homedir()) {
  return path.join(bridgeHome(env, home), 'credentials.json')
}
