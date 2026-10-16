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

import os from 'node:os'
import path from 'node:path'

export function bridgeHome(env = process.env, home = os.homedir()) {
  const override = String(env.BRIDGE_HOME ?? '').trim()
  return override !== '' ? path.resolve(override) : path.join(home, '.claude-code-openai-bridge')
}

export function credentialFile(env = process.env, home = os.homedir()) {
  return path.join(bridgeHome(env, home), 'credentials.json')
}
