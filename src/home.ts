// Where the data directory lives.
//
// This is a separate module to **break a circular dependency**: `config.ts` needs
// the source registry, the registry's OpenCode client needs the data directory,
// and the three importing each other triggers a TDZ error under ESM
// (`Cannot access 'OPENCODE' before initialization`). This module imports
// nothing, so anything can safely depend on it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Data directory name. */
export const HOME_DIR = '.flow-one'
/** Directory name from before the rename (claude-code-openai-bridge → flow-one). */
export const LEGACY_HOME_DIR = '.claude-code-openai-bridge'

/**
 * The data directory: `BRIDGE_HOME` wins, otherwise `~/.flow-one`.
 *
 * The rename must not lose an existing login — the credentials (login state for
 * both Tencent lines plus the OpenCode Go key) sit in the old directory. So when
 * **the new directory is absent and the old one exists, keep using the old one**:
 * the rename is invisible to existing users, and anyone who wants to move can
 * `mv` it themselves (`fo status` mentions it once but never touches credentials).
 */
export function bridgeHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = String(env.BRIDGE_HOME ?? '').trim()
  if (override !== '') return path.resolve(override)
  const current = path.join(home, HOME_DIR)
  if (fs.existsSync(current) || !fs.existsSync(path.join(home, LEGACY_HOME_DIR))) return current
  return path.join(home, LEGACY_HOME_DIR)
}

/** Reports that the pre-rename directory is still in use (status / doctor use it to suggest a move). */
export function legacyHomeInUse(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): boolean {
  if (String(env.BRIDGE_HOME ?? '').trim() !== '') return false
  return !fs.existsSync(path.join(home, HOME_DIR)) && fs.existsSync(path.join(home, LEGACY_HOME_DIR))
}

export function credentialFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(bridgeHome(env, home), 'credentials.json')
}
