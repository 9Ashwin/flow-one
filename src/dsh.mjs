/**
 * 把本桥接进 DSH（DeepSeek Harness）。
 *
 * 为什么要单独一个模块：它动的是**别人家**的两份文件 —— profile 的 `cordis.patch.yml`
 * （写 `llm-pi-ai` 的 provider）与凭据 seam 的 `.credentials.yaml`（存桥的门禁口令）。
 * 写坏了 DSH 会起不来，所以这块逻辑必须能离线测。
 *
 * 两条纪律（与 install.mjs 一致）：
 *
 * 1. **只碰自己写的那一段**：provider 用注释标记圈起来，重跑替换整段、卸载删掉整段；
 * 手写进去的旧条目（没有标记的）在写入时顺手清掉，避免同一个 key 出现两次。
 * 2. **写前备份**（`<文件>.bak-<时间戳>`）。
 *
 * @module src/dsh.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic.mjs'

/** DSH 数据目录；`DSH_HOME` 可改道（与 config.mjs 读网关密钥的口径一致）。 */
export function dshHome(env = process.env, home = os.homedir()) {
  const override = String(env.DSH_HOME ?? '').trim()
  return override !== '' ? path.resolve(override) : path.join(home, '.dsh')
}

/** profile 配置：桌面版优先，其次 web。都没有说明这台机器没装过 DSH。 */
export function dshProfileFile({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  const root = path.join(dshHome(env, home), 'profiles')
  for (const profile of ['desktop', 'web']) {
    const file = path.join(root, profile, 'cordis.patch.yml')
    if (exists(file)) return { file, profile }
  }
  return undefined
}

/** 凭据 seam 文件。 */
export function dshCredentialFile({ env = process.env, home = os.homedir() } = {}) {
  return path.join(dshHome(env, home), '.credentials.yaml')
}

/** provider 里的 `apiKeyEnv` 指向这个引用名。 */
export const CREDENTIAL_REF = 'FLOW_ONE_BRIDGE_KEY'

/** 托管段的起止标记。手改段内内容会被下一次 `fo setup` 覆盖。 */
export const BLOCK_BEGIN = '# >>> flow-one 托管：DSH provider（由 `fo setup` 维护，手改会被覆盖）>>>'
export const BLOCK_END = '# <<< flow-one 托管：DSH provider <<<'

/** DSH 侧只接腾讯两条线（oc/ocg 在 DSH 里本来就有自己的 provider）。 */
export const DSH_SOURCE_IDS = ['cn', 'intl']

const ROUTES = { cn: 'workbuddy-cn', intl: 'workbuddy-intl' }
const LABELS = { cn: 'WorkBuddy 国内版（CodeBuddy）', intl: 'WorkBuddy 国际版' }

/**
 * 只把腾讯两条线写进 DSH：`oc/`、`ocg/` 在 DSH 里本来就有自己的 provider，
 * 再写一份只会让模型选择器里出现重复条目。
 */
export function dshSources(rows) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? '')
    const slash = id.indexOf('/')
    if (slash <= 0) continue
    const product = id.slice(0, slash)
    if (ROUTES[product] === undefined) continue
    if (!groups.has(product)) groups.set(product, [])
    groups.get(product).push(row)
  }
  return [...groups].map(([id, models]) => ({ id, models }))
}

/**
 * 检测文件的换行风格。
 *
 * Windows 上手改过的配置常常是 CRLF；我们只插入、不改别人已有的行，
 * 所以插入的那几行要跟着文件走，别把一份 CRLF 的文件搞成混合换行。
 */
export function newlineOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

/** 生成托管段（含标记）；`indent` 是 sibling provider 的缩进。 */
export function dshProviderBlock({ port, sources, indent = 6 }) {
  const pad = offset => ' '.repeat(indent + offset)
  const lines = [pad(0) + BLOCK_BEGIN]
  for (const source of sources) {
    lines.push(`${pad(0)}${ROUTES[source.id]}:`)
    lines.push(`${pad(2)}displayName: "${LABELS[source.id]}"`)
    lines.push(`${pad(2)}apiKeyEnv: ${CREDENTIAL_REF}`)
    lines.push(`${pad(2)}api: anthropic-messages`)
    lines.push(`${pad(2)}baseURL: http://127.0.0.1:${port}`)
    lines.push(`${pad(2)}models:`)
    for (const model of source.models) {
      lines.push(`${pad(4)}- id: ${model.id}`)
      lines.push(`${pad(6)}name: "${String(model.name ?? model.id).replace(/"/g, "'")}"`)
      if (Number.isFinite(model.contextWindow)) lines.push(`${pad(6)}contextWindow: ${model.contextWindow}`)
      if (Number.isFinite(model.maxOutputTokens)) lines.push(`${pad(6)}maxTokens: ${model.maxOutputTokens}`)
    }
  }
  lines.push(pad(0) + BLOCK_END)
  return lines.join('\n')
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

/** 去掉托管段（含标记行）。不在就原样返回。 */
export function stripManagedBlock(text) {
  const lines = String(text).split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) { inside = true; continue }
    if (inside) { if (line.trim() === BLOCK_END) inside = false; continue }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 去掉手写的 `workbuddy-cn:` / `workbuddy-intl:` 条目（早期手工配的那些没有标记）。
 * 判据是缩进：从该行起，直到遇见缩进不大于它的下一行。
 */
export function stripLooseProviders(text) {
  const lines = String(text).split('\n')
  const out = []
  let skipIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (skipIndent >= 0) {
      if (trimmed === '' || indentOf(line) > skipIndent) continue
      skipIndent = -1
    }
    if (/^\s*workbuddy-(cn|intl):\s*$/.test(line)) { skipIndent = indentOf(line); continue }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 找到 `llm-pi-ai` 那个 loader 条目里 `providers:` 的**末尾**（插入点）与 sibling 缩进。
 *
 * 插在末尾而不是 `providers:` 正下方：既有 provider 原地不动，diff 里就只会多出我们
 * 那一段（「每一行改动都能追溯到用户的请求」）。
 */
export function providersAnchor(text) {
  const lines = String(text).split('\n')
  const entry = lines.findIndex(line => /^\s*-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(line))
  if (entry === -1) return undefined
  for (let i = entry + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i])) break // 下一个 loader 条目，说明这个条目里没有 providers
    const match = /^(\s*)providers:\s*$/.exec(lines[i])
    if (match === null) continue
    const base = match[1].length
    // sibling 缩进 = 第一条比 providers 更深的行；没有就按 +2
    let indent = base + 2
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue
      const sibling = indentOf(lines[j])
      if (sibling > base) indent = sibling
      break
    }
    // 末尾 = 最后一条仍属于这个 providers 映射的行（空白/更深缩进）
    let last = i
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') { last = j; continue }
      if (indentOf(line) > base) { last = j; continue }
      break
    }
    return { line: last, indent }
  }
  return undefined
}

function backup(file) {
  if (!fs.existsSync(file)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

/** 这段托管内容是否已经在文件里。 */
export function dshManagedIn(text) {
  return String(text).includes(BLOCK_BEGIN)
}

/**
 * 写入（或更新）DSH 的 provider 段。
 *
 * @returns {{ok: true, file: string, changed: boolean, backup?: string} | {ok: false, reason: string}}
 */
export function applyDshProviders({ file, port, sources, backupFile = backup }) {
  if (!fs.existsSync(file)) return { ok: false, reason: `没找到 DSH 的 profile 配置：${file}` }
  const original = fs.readFileSync(file, 'utf8')
  let text = stripManagedBlock(stripLooseProviders(original))
  const anchor = providersAnchor(text)
  if (anchor === undefined) {
    return {
      ok: false,
      reason: `没在 ${file} 里找到 llm-pi-ai 的 providers 段（DSH 版本不同？），可以照着 \`fo client\` 的信息手动加`,
    }
  }
  const lines = text.split('\n')
  // CRLF 文件里，插入的每一行也要带 \r，否则整份文件变成混合换行
  const cr = newlineOf(original) === '\r\n' ? '\r' : ''
  const block = dshProviderBlock({ port, sources, indent: anchor.indent })
    .split('\n').map(line => line + cr)
  lines.splice(anchor.line + 1, 0, ...block)
  text = lines.join('\n')
  if (text === original) return { ok: true, file, changed: false }
  const backupPath = backupFile(file)
  writeFileAtomic(file, text, 0o644)
  return { ok: true, file, changed: true, backup: backupPath }
}

/** 卸载：只删托管段（手写的东西不碰）。 */
export function removeDshProviders({ file, backupFile = backup }) {
  if (!fs.existsSync(file)) return { ok: true, removed: false }
  const original = fs.readFileSync(file, 'utf8')
  if (!dshManagedIn(original)) return { ok: true, removed: false }
  const backupPath = backupFile(file)
  writeFileAtomic(file, stripManagedBlock(original), 0o644)
  return { ok: true, removed: true, backup: backupPath }
}

/** 现在 DSH 里有没有我们托管的 provider 段（判断「这份配置是不是我们的」）。 */
export function dshCurrentlyManaged({ env = process.env, home = os.homedir() } = {}) {
  const target = dshProfileFile({ env, home })
  if (target === undefined) return false
  try {
    return dshManagedIn(fs.readFileSync(target.file, 'utf8'))
  } catch {
    return false
  }
}

/** 把门禁口令写进 DSH 的凭据 seam（`refs.FLOW_ONE_BRIDGE_KEY`）。 */
export function setDshCredential({ file, apiKey }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return { ok: false, reason: '口令为空，DSH 侧没得引用' }
  if (!fs.existsSync(file)) return { ok: false, reason: `没找到 DSH 的凭据文件：${file}` }
  const original = fs.readFileSync(file, 'utf8')
  const line = `  ${CREDENTIAL_REF}: "${apiKey}"`
  let text
  if (new RegExp(`^\\s*${CREDENTIAL_REF}:`, 'm').test(original)) {
    text = original.replace(new RegExp(`^\\s*${CREDENTIAL_REF}:.*$`, 'm'), line)
  } else if (/^refs:\s*$/m.test(original)) {
    text = original.replace(/^refs:\s*$/m, `refs:${newlineOf(original)}${line}`)
  } else {
    return { ok: false, reason: `${file} 里没有 refs 段（DSH 版本不同？）` }
  }
  if (text === original) return { ok: true, file, changed: false }
  const backupPath = backup(file)
  writeFileAtomic(file, text, 0o600)
  return { ok: true, file, changed: true, backup: backupPath }
}

/** 卸载：删掉我们写的那条凭据引用。 */
export function removeDshCredential({ file, backupFile = backup }) {
  if (!fs.existsSync(file)) return { ok: true, removed: false }
  const original = fs.readFileSync(file, 'utf8')
  const pattern = new RegExp(`^\\s*${CREDENTIAL_REF}:.*\\n?`, 'm')
  if (!pattern.test(original)) return { ok: true, removed: false }
  const backupPath = backupFile(file)
  writeFileAtomic(file, original.replace(pattern, ''), 0o600)
  return { ok: true, removed: true, backup: backupPath }
}

/**
 * 「帮我把 DSH 也配了」的完整一步：provider 段 + 凭据引用。
 *
 * @returns {{ok: boolean, file?: string, credential?: string, changed?: boolean, backup?: string, reason?: string}}
 */
export function applyDshConfig({ port, apiKey, rows, env = process.env, home = os.homedir() }) {
  const target = dshProfileFile({ env, home })
  if (target === undefined) {
    return { ok: false, reason: `这台机器上没有 ~/.dsh/profiles 下的 profile 配置，DSH 配不了；先装 DSH 再用 fo setup --clients dsh` }
  }
  const sources = dshSources(rows)
  if (sources.length === 0) {
    return { ok: false, reason: '这次没有挂 WorkBuddy 的 cn/intl 模型，DSH 侧没东西可配（先 fo setup 选一条腾讯来源）' }
  }
  const providers = applyDshProviders({ file: target.file, port, sources })
  if (providers.ok !== true) return providers
  const credential = setDshCredential({ file: dshCredentialFile({ env, home }), apiKey })
  if (credential.ok !== true) return credential
  return {
    ok: true,
    file: target.file,
    credential: dshCredentialFile({ env, home }),
    changed: providers.changed === true || credential.changed === true,
    backup: providers.backup ?? credential.backup,
    models: sources.reduce((sum, source) => sum + source.models.length, 0),
  }
}

/** 卸载：provider 段与凭据引用都撤掉。 */
export function removeDshConfig({ env = process.env, home = os.homedir() } = {}) {
  const target = dshProfileFile({ env, home })
  const providers = target === undefined ? { ok: true, removed: false } : removeDshProviders({ file: target.file })
  const credential = removeDshCredential({ file: dshCredentialFile({ env, home }) })
  return { providers, credential, removed: providers.removed === true || credential.removed === true }
}
