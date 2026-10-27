// Installer: write the Claude Code config + keep the reverse proxy resident.
//
// Two rules:
//
// 1. **Touch only the keys we own.** Claude Code's `settings.json` is the user's turf:
//    it may already hold other gateways, hooks, permission rules. Merge only the few
//    ANTHROPIC_* keys under `env` plus one `modelOverrides` entry, keep the rest as-is,
//    and back up before writing.
// 2. **Uninstall by the ledger.** When writing, record "which keys I wrote, with what
//    value" in `BRIDGE_HOME/install.json`; uninstall removes only keys whose value is
//    **still the one we wrote** — anything the user edited afterwards is left alone, so
//    their hand edits do not get eaten.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Options accepted by `execFileSync`, as used by `platformRun`. */
type RunOptions = NonNullable<Parameters<typeof execFileSync>[2]>
import { fileURLToPath } from 'node:url'
import { bridgeHome } from './config.ts'
import { SOURCES } from './sources.ts'
import { writeFileAtomic } from './atomic.ts'

const CLI_PATH = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli.ts' : '../cli.js', import.meta.url))

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/** Whether this label is loaded in launchd. */
function launchdLoaded(label: string): boolean {
  try {
    platformRun('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/**
 * Single entry point for platform commands.
 *
 * This must **never actually execute inside a test process**: `launchctl` and `systemctl`
 * act on a **label**, and labels are shared machine-wide — even with HOME pointed at a
 * temporary directory, one `bootout gui/501/dev.claude-code-openai-bridge` still stops the
 * user's *real* service (the file is in the temporary directory so it survives, the service
 * does not, and Claude Code starts getting ECONNREFUSED). That accident happened, so this
 * records the intent under test instead: assert on `serviceCalls` to inspect the sequence,
 * run outside a test process to actually execute.
 */
export const serviceCalls: Array<{ command: string; args: string[] }> = []

/**
 * Normalise `execFileSync` output to a string.
 *
 * With `stdio: 'ignore'` it returns **null**, not an empty string — calling
 * `.toString()` on that throws `TypeError: Cannot read properties of null`.
 */
export function commandOutput(result: unknown): string {
  return result === null || result === undefined ? '' : `${result}`
}

function platformRun(command: string, args: string[], options: RunOptions = {}): string {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    serviceCalls.push({ command, args })
    return ''
  }
  // Hit on a real machine (2026-10-20): this used to be `execFileSync(...).toString()`.
  // `launchdLoaded` passes `stdio: 'ignore'` (a successful call returns null), so a
  // successful call threw TypeError too and was caught as "not loaded". installService then
  // skipped bootout, bootstrap hit `Bootstrap failed: 5: Input/output error` and returned
  // ok:false, **leaving the old process running with the old API key**: the user saw "the
  // config is clearly written, yet Claude Code keeps getting 401".
  return commandOutput(execFileSync(command, args, options))
}

export const SERVICE_LABEL = 'dev.flow-one'
/**
 * The service label from before the rename.
 *
 * Leave it alone and you get "old service still running, new one installed too" — two
 * processes fighting over the same port (whoever starts first wins), so the service works
 * intermittently and nothing in the UI shows it.
 */
export const LEGACY_SERVICE_LABEL = 'dev.claude-code-openai-bridge'

/**
 * Which names the `service` field in `/health` is allowed to report.
 *
 * After the rename we **must accept the old one too**: what is running may be the copy
 * installed before the rename (a global npm install), and it still reports the old name.
 * Accepting only the new name turns "the service is plainly running" into "nobody is
 * listening" — hit on a real machine: doctor printed ✘ "no service is running on the port
 * the config points at" while `claude` in fact worked.
 */
export const HEALTH_SERVICE_NAMES = new Set(['flow-one', 'claude-code-openai-bridge'])

/**
 * The `XDG_RUNTIME_DIR` that `systemctl --user` needs.
 *
 * Actually stepped on (2026-10-16): over SSH or in a non-login shell this variable is
 * often empty, so every `systemctl --user` call fails with `Failed to connect to bus: No
 * medium found`. The symptom is that the wizard says "config written" while the unit file
 * never landed and nothing listens on 8788 — the user goes back to Claude Code and sees
 * only ECONNREFUSED, while the real error was swallowed at the install step.
 *
 * dbus has actually been at `/run/user/<uid>/bus` all along; nobody pointed at the path
 * (if `/run/user/<uid>` exists, the user session exists). Fill it in here; a pure function,
 * so it can be asserted offline.
 */
export function xdgRuntimeDir(env = process.env, { uid = process.getuid?.(), exists = fs.existsSync } = {}) {
  const current = String(env.XDG_RUNTIME_DIR ?? '').trim()
  if (current !== '') return current
  // Without a uid, do not build `/run/user/undefined` (on Windows `process.getuid` does
  // not exist at all)
  if (!Number.isInteger(uid)) return undefined
  const fallback = `/run/user/${uid}`
  return exists(fallback) ? fallback : undefined
}

/** Call `systemctl --user` with `XDG_RUNTIME_DIR` filled in first. */
function systemctl(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const dir = xdgRuntimeDir(env)
  return platformRun('systemctl', ['--user', ...args], {
    stdio: 'pipe',
    env: dir === undefined ? env : { ...env, XDG_RUNTIME_DIR: dir },
  })
}

/**
 * What to say when loading the service fails.
 *
 * The raw dbus error (`Failed to connect to bus: No medium found`) tells the user
 * nothing actionable and reads like "this tool does not support this machine",
 * which makes people give up. That class is recognised separately and answered with
 * two concrete routes; every other error is passed through unchanged so the real
 * cause is not hidden.
 */
/** Ledger of everything this tool has written, so `uninstall` can restore exactly that. */
export interface InstallState {
  claudeSettings?: {
    file: string
    backup: string | null
    env: Record<string, string>
    previousModel: string | null
  }
  service?: {
    kind: 'launchd' | 'systemd'
    path: string
    port: number
    env: Record<string, string>
    cliPath: string
  }
  autoStart?: boolean
  autoStartAsked?: boolean
  clients?: string[]
  clientsAsked?: boolean
  clientConfig?: unknown
  clientConfigAsked?: boolean
  bridge?: {
    port: number
    apiKey: string
    model: string
    contextWindow?: number
    lastModels?: Record<string, { model: string; contextWindow?: number }>
    savedAt: string
  }
}

/** The subset of `settings.json` this tool reads and writes. */
export interface SettingsJson {
  model?: string
  env?: Record<string, string | undefined>
  [key: string]: unknown
}

export function serviceLoadReason(message: unknown, file: string): string {
  const text = String(message ?? '')
  if (/Failed to connect to bus|No medium found|System has not been booted with systemd/i.test(text)) {
    return (
      `service file written to ${file}, but this machine has no usable systemd user session (${text}). ` +
      'Either run `loginctl enable-linger $USER` and log back in, or run `fo` in the foreground.'
    )
  }
  return `service file written to ${file}, but loading it failed: ${text}`
}

export function installStatePath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(bridgeHome(env, home), 'install.json')
}

export function readInstallState(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): InstallState {
  try {
    const parsed = JSON.parse(fs.readFileSync(installStatePath(env, home), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as InstallState) : {}
  } catch {
    return {}
  }
}

function writeInstallState(
  state: InstallState,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): void {
  const file = installStatePath(env, home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Temporary file plus rename: the ledger is the only record of what was written,
  // and half a JSON file means the record is lost.
  writeJsonAtomic(file, state, 0o600)
}

/** Claude Code's config directory; `CLAUDE_CONFIG_DIR` wins. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = String(env.CLAUDE_CONFIG_DIR ?? '').trim()
  return override !== '' ? path.resolve(override) : path.join(home, '.claude')
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(claudeConfigDir(env, home), 'settings.json')
}

function readJson(file: string): SettingsJson {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Whether this client configuration is "ours": the ledger records that we wrote it,
 * or it already points at the bridge's port.
 *
 * Why this matters: every `setup` run **rotates to a new key** and switches the
 * model. If the configuration points at this bridge but is left unwritten because
 * "the user chose not to write last time", the client keeps sending the old key and
 * gets a 401, staying on the previous model (real machine 2026-10-22: `cn/…` with an
 * old token left in settings.json while the bridge had moved to `ocg/…` with a new
 * one). Not writing in that case is not respecting the user, it is leaving a working
 * configuration broken.
 *
 * So opting out only means "do not take over configuration that is not ours"; once it
 * is ours, key and model must follow. To keep this tool away entirely, say
 * `--no-client` explicitly.
 */
export function clientConfigIsOurs({
  port,
  file = claudeSettingsPath(),
  state = readInstallState(),
}: { port?: number; file?: string; state?: InstallState } = {}): boolean {
  if (state?.claudeSettings !== undefined) return true
  let target: URL
  try {
    const baseUrl = readJson(file).env?.ANTHROPIC_BASE_URL
    if (typeof baseUrl !== 'string' || baseUrl === '') return false
    target = new URL(baseUrl)
  } catch {
    return false
  }
  const loopback = target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1'
  return loopback && Number(target.port) === Number(port)
}

/**
 * Both the ledger and `settings.json` are persisted through here.
 *
 * The cross-platform cost of "temporary file plus rename" (EPERM when the target is
 * held open on Windows) lives in {@link writeFileAtomic}; this only shapes the JSON.
 */
function writeJsonAtomic(file: string, value: unknown, mode: number = 0o600): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

/**
 * The `[1m]` suffix follows the **model's real window**: only above 200k. That is Claude
 * Code's own "register me as 1M context" marker; adding it to a 200k model makes Claude
 * Code compress context only at 1M and then run into the model's real ceiling (OpenCode's
 * free tier `deepseek-v4.1-flash-free` is exactly 200k). An unknown window counts as "do
 * not add" — Claude Code's default assumption for unrecognised IDs is 200k.
 *
 * Exported separately because the "do not write the client config" path also has to print
 * this **bare/suffixed** ID for the user to fill in himself; both sides must use the same
 * algorithm.
 */
export function sizedModelId(model: string, contextWindow?: number): string {
  const base = String(model ?? '').replace(/\[1m\]$/, '')
  const wants1M = String(model ?? '').endsWith('[1m]') || (contextWindow !== undefined && contextWindow > 200_000)
  return wants1M ? `${base}[1m]` : base
}

/**
 * Write the proxy's connection parameters into Claude Code's settings.json.
 *
 * While we are here, why we do **not** write `modelOverrides`: the official way to silence
 * the diagnostic is to write keys as Claude's own model IDs (i.e. make Claude Code believe
 * it runs Opus), at the price of it then applying that model's window and behaviour — not
 * worth paying for one line of stderr noise.
 *
 * @param {{file?: string, baseUrl: string, apiKey: string, model: string, contextWindow?: number}} options
 */
export function installClaudeSettings(options: {
  file?: string
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
}): { file: string; backup: string | undefined; env: Record<string, string> } {
  const file = options.file ?? claudeSettingsPath()
  const settings = readJson(file)
  const backupPath = backup(file)
  // It strips the suffix before sending, so the upstream always sees the bare ID.
  const sized = sizedModelId(options.model, options.contextWindow)
  const env = {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.apiKey,
    ANTHROPIC_MODEL: sized,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: sized,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sized,
    ANTHROPIC_DEFAULT_OPUS_MODEL: sized,
  }
  settings.env = { ...settings.env, ...env }
  // Pin the top-level `model` field as well: which of it and env.ANTHROPIC_MODEL wins is
  // decided by Claude Code's own version, and when the two disagree it silently runs a
  // different model (a real hazard: after switching from gateway mode to direct, this still
  // held `workbuddy/xxx`, an ID absent from the direct catalogue, so requests fell through
  // to the fallback model). Keep one source of truth: both fields always get the same value.
  const state = readInstallState()
  const record = state.claudeSettings
  const previousModel =
    record?.file === file && settings.model === record.env?.ANTHROPIC_MODEL ? record.previousModel : settings.model
  settings.model = sized
  writeJsonAtomic(file, settings, 0o644)
  state.claudeSettings = {
    file,
    backup: backupPath ?? null,
    env,
    // Ledger: restore must put `model` back to what it was before we changed it
    previousModel: previousModel === undefined ? null : previousModel,
  }
  writeInstallState(state)
  return { file, backup: backupPath, env }
}

/**
 * Restore. Remove only keys whose value is **still the one we wrote** — anything the user
 * edited afterwards stays.
 */
export function uninstallClaudeSettings(): {
  file?: string
  removed?: string[]
  backup?: string
  skipped?: boolean
  reason?: string
} {
  const state = readInstallState()
  const record = state.claudeSettings
  if (record === undefined) return { skipped: true, reason: 'no record of anything this tool wrote' }
  const file = record.file
  if (!fs.existsSync(file)) return { skipped: true, reason: `${file} does not exist` }
  const settings = readJson(file)
  const removed = []
  for (const [key, value] of Object.entries(record.env ?? {})) {
    if (settings.env?.[key] !== value) continue
    delete settings.env[key]
    removed.push(key)
  }
  if (settings.env !== undefined && Object.keys(settings.env).length === 0) delete settings.env
  // Top-level model field: restore only if it is still the one we wrote (a user edit stays)
  const written = record.env?.ANTHROPIC_MODEL
  if (written !== undefined && settings.model === written) {
    if (record.previousModel === null || record.previousModel === undefined) delete settings.model
    else settings.model = record.previousModel
    removed.push('model')
  }
  const backupPath = backup(file)
  writeJsonAtomic(file, settings, 0o644)
  const next = readInstallState()
  delete next.claudeSettings
  writeInstallState(next)
  return { file, removed, backup: backupPath }
}

function xmlEscape(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The launchd plist text; exported separately so it can be asserted offline. */
export function launchAgentPlist({
  port,
  apiKey,
  env: extra = {},
  node = process.execPath,
  cli = CLI_PATH,
  logDir,
}: {
  port: number
  apiKey: string
  env?: Record<string, string>
  node?: string
  cli?: string
  logDir?: string
}): string {
  const env = {
    BRIDGE_PORT: String(port),
    ...(apiKey === '' ? {} : { BRIDGE_API_KEY: apiKey }),
    // Mode, upstream and model must go into the service environment: the service starts
    // without arguments, and without them it falls back to "direct mode + auto-pick model",
    // disagreeing with what the user just chose.
    ...extra,
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir ?? '', 'bridge.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir ?? '', 'bridge.err.log'))}</string>
</dict>
</plist>
`
}

export function systemdUnit({
  port,
  apiKey,
  env: extra = {},
  node = process.execPath,
  cli = CLI_PATH,
}: {
  port: number
  apiKey: string
  env?: Record<string, string>
  node?: string
  cli?: string
}): string {
  const environment = [`Environment=BRIDGE_PORT=${port}`]
  if (apiKey !== '') environment.push(`Environment=BRIDGE_API_KEY=${apiKey}`)
  for (const [key, value] of Object.entries(extra)) environment.push(`Environment=${key}=${value}`)
  // `Description=` is English like the rest of the service file: it is read by
  // operators and by `systemctl --user status`, not inside this tool's own UI.
  return `[Unit]
Description=flow-one (local reverse proxy for Claude Code)
After=network-online.target

[Service]
ExecStart=${node} ${cli}
${environment.join('\n')}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`
}

/** Where the service file lives on this platform, and how it gets loaded. */
export interface ServicePaths {
  kind: 'launchd' | 'systemd' | 'unsupported'
  path: string
  logDir: string
}

function servicePathsFor(label: string): ServicePaths {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return {
      kind: 'launchd',
      path: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
      logDir: path.join(home, 'Library', 'Logs'),
    }
  }
  if (process.platform === 'linux') {
    return {
      kind: 'systemd',
      path: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', `${label}.service`),
      logDir: path.join(home, '.local', 'state'),
    }
  }
  return { kind: 'unsupported', path: '', logDir: '' }
}

function servicePaths(): ServicePaths {
  return servicePathsFor(SERVICE_LABEL)
}

/**
 * A test process **must not** touch real service files.
 *
 * An accident actually happened: a demo script pointed only `BRIDGE_HOME` at a temporary
 * directory and forgot `HOME`, so the `uninstallService()` it called sent bootout to the
 * **real** launchd service and deleted the plist — the user's Claude Code hit ECONNREFUSED
 * on the spot. This class of mistake should not rely on people remembering to isolate;
 * the code should refuse: inside a test process (the Node test runner sets
 * NODE_TEST_CONTEXT) the service file must live under the system temp directory,
 * otherwise throw.
 */
function assertScratchServicePath(paths: ServicePaths): void {
  if (process.env.NODE_TEST_CONTEXT === undefined) return
  // Unsupported platforms have no service file, hence no machine-wide resource keyed by
  // label to harm — letting it through is honest, not a missed check. On POSIX it must be
  // blocked.
  if (paths.path === '') return
  // Compare by **string prefix** instead of realpath-ing the parent directory: the parent
  // usually does not exist yet, realpathSync throws, and my first version treated that
  // exception as "safe" and let it through — so the guard was effectively a no-op.
  // On macOS /var and /private/var are two spellings of one place, so accept both roots.
  const roots = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map(root => (root.endsWith('/') ? root : `${root}/`))
  if (!roots.some(root => paths.path.startsWith(root))) {
    // The message stays Chinese because test/migration.test.ts asserts this exact text
    // (the isolation-guard test); change both sides together if it is ever translated.
    throw new Error(`测试里不允许操作真实服务文件：${paths.path}\n` + '把 HOME（不只是 BRIDGE_HOME）指到临时目录再跑。')
  }
}

/** Where the pre-rename service file lives (if it exists, it was installed before the rename). */
export function legacyServicePaths() {
  return servicePathsFor(LEGACY_SERVICE_LABEL)
}

export function serviceState() {
  const { kind, path: file } = servicePaths()
  const legacy = legacyServicePaths()
  return {
    kind,
    path: file,
    installed: file !== '' && fs.existsSync(file),
    // Reported separately: when the new-named service file is missing the UI says "not
    // installed", while the old service is in fact still running and holding the port —
    // the most easily misread state.
    legacyInstalled: legacy.path !== '' && fs.existsSync(legacy.path),
    supported: kind !== 'unsupported',
  }
}

/**
 * The answer to "install as an auto-start service?", as recorded in the ledger.
 *
 * Interactive setup runs repeatedly (mounting another source, changing the model, both go
 * through it again); once asked, do not ask a second time — the user complained explicitly
 * about "after installing once, every configuration run asks again whether to auto-start".
 * This only reads and writes the answer; **whether and how to ask** is the wizard's call
 * (this layer does no interaction).
 */
export function serviceChoice(): { asked: boolean; autoStart: boolean } {
  const state = readInstallState()
  return { asked: state.autoStartAsked === true, autoStart: state.autoStart === true }
}

/** Record this question's answer: the next configuration run will not ask again. */
export function recordServiceChoice(autoStart: boolean): void {
  const state = readInstallState()
  state.autoStart = autoStart === true
  state.autoStartAsked = true
  writeInstallState(state)
}

/**
 * Clients we can configure for the user. `claude` = write `~/.claude/settings.json`;
 * `dsh` = write the `llm-pi-ai` provider in the DSH profile (see src/dsh.ts).
 */
export const CLIENT_TARGETS = ['claude', 'dsh']

/**
 * The answer to "which clients should we write config for?", as recorded in the ledger.
 *
 * This tool's job is **providing the reverse proxy**; editing client config is a favour on
 * the side. Whether and which, the answer is recorded here: once asked, never asked again
 * (AGENTS.md "do not ask the same thing twice").
 *
 * Old ledgers only had a boolean `clientConfig` (back then the question was only whether to
 * write Claude Code). Moving from "whether" to "for whom" is a semantic change, and asking
 * again beats guessing for the user — so old values always count as **never asked**.
 */
export function clientChoice(): { asked: boolean; clients: string[] } {
  const state = readInstallState()
  if (Array.isArray(state.clients)) {
    return { asked: state.clientsAsked === true, clients: state.clients.filter(id => CLIENT_TARGETS.includes(id)) }
  }
  return { asked: false, clients: [] }
}

/** Record this question's answer: the next configuration run will not ask again. */
export function recordClientChoice(clients: unknown): void {
  const state = readInstallState()
  state.clients = (Array.isArray(clients) ? clients : []).filter(id => CLIENT_TARGETS.includes(id))
  state.clientsAsked = true
  // Drop the old fields: leaving them lets the next read see two contradictory answers
  delete state.clientConfig
  delete state.clientConfigAsked
  writeInstallState(state)
}

/**
 * This configuration's connection parameters (port / token / model).
 *
 * Independent of "write the client config or not": even someone who opted out needs a way
 * to get the token (`fo client` prints it, and running the bridge in the foreground needs
 * it too). Written into the ledger's `bridge` section.
 */
export function bridgeRecord(): Partial<NonNullable<InstallState['bridge']>> {
  const record = readInstallState().bridge
  return record !== null && typeof record === 'object' ? record : {}
}

/**
 * Record this run's connection parameters, and **remember the last model per source**.
 *
 * Why per source: one bridge process mounts every source, so changing the prefix of
 * `ANTHROPIC_MODEL` is changing the source. But switching back used to mean scrolling
 * through dozens of models again — "I already configured this, yet I have to walk the flow
 * once more" (user report 2026-10-27). Store `{source: model}` and `fo use` picks it
 * straight up when switching back.
 *
 * `contextWindow` must be persisted alongside: `fo client` uses it to decide the `[1m]`
 * suffix, and without it a 1M model is reported to the user as 200k.
 *
 * When `source` is omitted it is derived from the **literal prefix** (only `cn/` `intl/`
 * `oc/` `ocg/` count), so setup's call site need not change and still records it. Literal
 * ids only, no aliases: in a gateway id `workbuddy/…` that `workbuddy` happens to be the
 * international edition's alias, and deriving by alias would misfile it as that source's
 * model.
 */
export function recordBridge({
  port,
  apiKey,
  model,
  contextWindow,
  source,
}: {
  port: number
  apiKey: string
  model: string
  contextWindow?: number
  source?: string
}): void {
  const state = readInstallState()
  const previous = bridgeRecord()
  const bare = String(model ?? '').replace(/\[[^\]]*\]$/, '')
  const lastModels =
    previous.lastModels !== null && typeof previous.lastModels === 'object' ? { ...previous.lastModels } : {}
  const key = typeof source === 'string' && source !== '' ? source : literalSourceOf(bare)
  if (key !== '') lastModels[key] = { model: bare, ...(Number.isFinite(contextWindow) ? { contextWindow } : {}) }
  state.bridge = {
    port,
    apiKey,
    model,
    ...(Number.isFinite(contextWindow) ? { contextWindow } : {}),
    ...(Object.keys(lastModels).length > 0 ? { lastModels } : {}),
    savedAt: new Date().toISOString(),
  }
  writeInstallState(state)
}

/** `cn/xxx` → `cn`; empty string when it is not the literal prefix of any known source. */
function literalSourceOf(model: string): string {
  const at = String(model).indexOf('/')
  if (at <= 0) return ''
  const prefix = String(model).slice(0, at)
  return SOURCES.some(source => source.id === prefix) ? prefix : ''
}

/**
 * Remove the pre-rename service: make it exit launchd / systemd first, then delete the
 * service file.
 *
 * Delete the file even if unloading fails: leaving behind a process that is "still running
 * with no service file left" is worse than leaving a file the next uninstall can clear.
 */
export function removeLegacyService(): { removed: boolean; path?: string } {
  const { kind, path: file } = legacyServicePaths()
  assertScratchServicePath(legacyServicePaths())
  if (kind === 'unsupported' || file === '' || !fs.existsSync(file)) return { removed: false }
  try {
    if (kind === 'launchd') {
      try {
        platformRun('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${LEGACY_SERVICE_LABEL}`], {
          stdio: 'ignore',
        })
      } catch {
        /* fine if it was never loaded */
      }
    } else {
      try {
        systemctl(['--user', 'disable', '--now', `${LEGACY_SERVICE_LABEL}.service`])
      } catch {
        /* fine if it was never installed */
      }
    }
  } catch {
    /* the branches above already guard themselves; this only keeps install from crashing */
  }
  try {
    fs.rmSync(file)
  } catch {
    return { removed: false, path: file }
  }
  return { removed: true, path: file }
}

/**
 * **Which copy of the code** the service file actually executes.
 *
 * Actually stepped on: a global install (`npm i -g` / that early npm link copy) points the
 * service at `…/lib/node_modules/flow-one/dist/cli.js`, which is a **snapshot** — afterwards,
 * whether you `git pull` or edit the repo, the service keeps running the old code and
 * nothing in the UI shows it (symptoms: "the new feature is on the command line but not in
 * the service", or "the fixed fingerprint still gets 400 from the service").
 *
 * So parse the service file here, so `status` and callers can compare it with the current
 * CLI path.
 */
/**
 * Extract the executed CLI path from the service file contents (pure function, so it can
 * be asserted offline).
 */
export function cliPathFromServiceFile(text: unknown, kind: string): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  if (kind === 'launchd') {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]
    if (block === undefined) return undefined
    const args = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1])
    return args.at(-1)
  }
  const exec = /^ExecStart=(.+)$/m.exec(text)?.[1]?.trim()
  if (exec === undefined) return undefined
  return exec.split(/\s+/).at(-1)
}

export function serviceCliPath() {
  const { kind, path: file } = servicePaths()
  if (file === '' || !fs.existsSync(file)) return undefined
  try {
    return cliPathFromServiceFile(fs.readFileSync(file, 'utf8'), kind)
  } catch {
    return undefined
  }
}

/**
 * The code this process is running. Only a path match with the service file proves "the
 * service runs the copy you edited".
 */
export function currentCliPath() {
  return CLI_PATH
}

/**
 * Install the auto-start background service; return what it actually did, so the UI can
 * report it truthfully.
 *
 * ⚠️ **The restart path must wait for bootout to land.** `launchctl bootout` is
 * asynchronous, and bootstrapping the same label right after it fails with
 * `Bootstrap failed: 5: Input/output error` — the user hits this every time they pick
 * "one-shot setup" a second time from the menu (real defect, fixed 2026-10-16). So poll
 * until it is really unloaded, then bootstrap, and give bootstrap a few retries.
 */
export async function installService({
  port,
  apiKey,
  env = {},
}: {
  port: number
  apiKey: string
  env?: Record<string, string>
}) {
  const { kind, path: file } = servicePaths()
  assertScratchServicePath(servicePaths())
  if (kind === 'unsupported') {
    return {
      ok: false,
      kind,
      reason: `auto-start is not supported on ${process.platform}; put \`node ${CLI_PATH}\` into your startup items yourself`,
    }
  }
  const logDir = bridgeHome()
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    kind === 'launchd' ? launchAgentPlist({ port, apiKey, env, logDir }) : systemdUnit({ port, apiKey, env }),
    { mode: 0o600 },
  )
  const state = readInstallState()
  state.service = { kind, path: file, port, env, cliPath: CLI_PATH }
  writeInstallState(state)

  const notes = []
  // Clear the pre-rename service before installing the new one: both alive would fight over
  // the same port
  const legacy = removeLegacyService()
  if (legacy.removed)
    notes.push(`cleared the pre-rename service ${LEGACY_SERVICE_LABEL} (so old and new do not fight over one port)`)
  try {
    if (kind === 'launchd') {
      const domain = `gui/${process.getuid?.() ?? 0}`
      if (launchdLoaded(SERVICE_LABEL)) {
        try {
          platformRun('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' })
        } catch {
          /* already gone also counts as success */
        }
        for (let attempt = 0; attempt < 40 && launchdLoaded(SERVICE_LABEL); attempt++) await sleep(250)
      }
      let loaded = false
      for (let attempt = 0; attempt < 5 && !loaded; attempt++) {
        try {
          platformRun('launchctl', ['bootstrap', domain, file], { stdio: 'pipe' })
          loaded = true
        } catch (error) {
          if (attempt === 4) throw error
          await sleep(400)
        }
      }
      notes.push('launchctl bootstrap loaded')
    } else {
      systemctl(['daemon-reload'])
      systemctl(['enable', `${SERVICE_LABEL}.service`])
      // `enable --now` does not restart an already-active process; `restart` covers both
      // first install and reconfiguration.
      systemctl(['restart', `${SERVICE_LABEL}.service`])
      notes.push('systemctl --user enable + restart done')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, kind, path: file, reason: serviceLoadReason(message, file) }
  }
  return { ok: true, kind, path: file, notes }
}

export function uninstallService() {
  const { kind, path: file } = servicePaths()
  assertScratchServicePath(servicePaths())
  // Take the pre-rename service along too: uninstall should leave nothing behind
  const legacy = removeLegacyService()
  // Forget the "install as an auto-start service" answer as well: the user came to
  // uninstall, so the next configuration run should ask again. This happens **before**
  // the "no service was ever installed" early return — a user who picked "do not install"
  // in the wizard last time answered that question too, and their answer should not survive
  // an uninstall. Same for "write client config": after uninstall it is a blank slate.
  const state = readInstallState()
  const remembered =
    'service' in state ||
    'autoStart' in state ||
    'autoStartAsked' in state ||
    'clients' in state ||
    'clientsAsked' in state ||
    'clientConfig' in state ||
    'clientConfigAsked' in state ||
    'bridge' in state
  delete state.service
  delete state.autoStart
  delete state.autoStartAsked
  delete state.clients
  delete state.clientsAsked
  delete state.clientConfig
  delete state.clientConfigAsked
  delete state.bridge
  // Write nothing when nothing was ever recorded: do not conjure an install.json just
  // because "nothing was deleted"
  if (remembered) writeInstallState(state)
  if (file === '' || !fs.existsSync(file)) {
    return legacy.removed
      ? { ok: true, kind, path: legacy.path, legacy: true }
      : { skipped: true, reason: 'no background service was installed' }
  }
  try {
    if (kind === 'launchd')
      platformRun('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`], { stdio: 'pipe' })
    else systemctl(['disable', '--now', `${SERVICE_LABEL}.service`])
  } catch {
    /* fine if it is not running; the file still has to go */
  }
  fs.rmSync(file, { force: true })
  return { ok: true, kind, path: file }
}
