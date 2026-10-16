/**
 * 安装器：写 Claude Code 配置 + 让反代常驻。
 *
 * 两条纪律：
 *
 * 1. **只碰自己要碰的键**。Claude Code 的 `settings.json` 是用户自己的地盘，
 *    里面可能已经有别的网关、hooks、权限规则。这里只合并 `env` 下的几个
 *    ANTHROPIC_* 键与 `modelOverrides` 的一条，其余原样保留，并且写前先备份。
 * 2. **卸载要认账**。写入时把「我写了哪些键、写成什么值」记在
 *    `BRIDGE_HOME/install.json`；卸载只删**值仍然等于我写的那个**的键 ——
 *    用户自己改过的就不动，免得把他的手改配置吃掉。
 *
 * @module src/install.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bridgeHome } from './config.mjs'

const CLI_PATH = fileURLToPath(new URL('../cli.mjs', import.meta.url))

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** launchd 里这个 label 是否已加载。 */
function launchdLoaded(label) {
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const SERVICE_LABEL = 'dev.claude-code-openai-bridge'

export function installStatePath(env = process.env, home = os.homedir()) {
  return path.join(bridgeHome(env, home), 'install.json')
}

export function readInstallState(env = process.env, home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(installStatePath(env, home), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeInstallState(state, env = process.env, home = os.homedir()) {
  const file = installStatePath(env, home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}

/** Claude Code 的配置目录；`CLAUDE_CONFIG_DIR` 优先。 */
export function claudeConfigDir(env = process.env, home = os.homedir()) {
  const override = String(env.CLAUDE_CONFIG_DIR ?? '').trim()
  return override !== '' ? path.resolve(override) : path.join(home, '.claude')
}

export function claudeSettingsPath(env = process.env, home = os.homedir()) {
  return path.join(claudeConfigDir(env, home), 'settings.json')
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  fs.renameSync(temporary, file)
}

function backup(file) {
  if (!fs.existsSync(file)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

// ── Claude Code 配置 ────────────────────────────────────────────────────────

/**
 * 把反代的接入参数写进 Claude Code 的 settings.json。
 *
 * `[1m]` 后缀按**模型真实窗口**决定：超过 200k 才加。那是 Claude Code 自己的
 * 「按 1M 上下文登记」标记；给一个 200k 的模型加它，会让 Claude Code 到 1M 才压缩
 * 上下文，然后撞上模型真实上限（OpenCode 免费档的 deepseek-v4.1-flash-free 就是
 * 200k）。窗口未知时按不加处理 —— Claude Code 对未识别 ID 的默认假设正是 200k。
 * 顺带说明为什么**不**写 `modelOverrides`：官方给的消诊断办法是把键写成
 * Claude 的模型 ID（等于让 Claude Code 以为自己在跑 Opus），代价是它随之套用
 * 那个模型的窗口与行为，不值得为一行 stderr 噪声付。
 *
 * @param {{file?: string, baseUrl: string, apiKey: string, model: string}} options
 */
export function installClaudeSettings(options) {
  const file = options.file ?? claudeSettingsPath()
  const settings = readJson(file)
  const backupPath = backup(file)
  const model = options.model
  // 窗口超过 200k 才登记 `[1m]`：它发请求前会把后缀剥掉，上游收到的永远是裸 ID。
  const wants1M = model.endsWith('[1m]') || (Number.isFinite(options.contextWindow) && options.contextWindow > 200_000)
  const sized = wants1M ? `${model.replace(/\[1m\]$/, '')}[1m]` : model.replace(/\[1m\]$/, '')
  const env = {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.apiKey,
    ANTHROPIC_MODEL: sized,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: sized,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sized,
    ANTHROPIC_DEFAULT_OPUS_MODEL: sized,
  }
  settings.env = { ...settings.env, ...env }
  // `model` 顶层字段也要一起钉住：它和 env.ANTHROPIC_MODEL 谁优先由 Claude Code
  // 自己的版本决定，两个字段说法不一致时就会静默跑成另一个模型（真实隐患：
  // 从网关模式切到直连后，这里还留着 `workbuddy/xxx`，而直连清单里没有这个 ID，
  // 请求会掉进兜底模型）。只留一个真相源：两个字段始终写成同一个值。
  const previousModel = settings.model
  settings.model = sized
  writeJsonAtomic(file, settings, 0o644)
  const state = readInstallState()
  state.claudeSettings = {
    file, backup: backupPath ?? null, env,
    // 认账：还原时要把 `model` 恢复成我们改它之前的样子
    previousModel: previousModel === undefined ? null : previousModel,
  }
  writeInstallState(state)
  return { file, backup: backupPath, env }
}

/**
 * 还原。只删「值仍然等于我们写的那份」的键 —— 用户之后自己改过就保留他的。
 */
export function uninstallClaudeSettings() {
  const state = readInstallState()
  const record = state.claudeSettings
  if (record === undefined) return { skipped: true, reason: '没有本工具写入过的记录' }
  const file = record.file
  if (!fs.existsSync(file)) return { skipped: true, reason: `${file} 不存在` }
  const settings = readJson(file)
  const removed = []
  for (const [key, value] of Object.entries(record.env ?? {})) {
    if (settings.env?.[key] !== value) continue
    delete settings.env[key]
    removed.push(key)
  }
  if (settings.env !== undefined && Object.keys(settings.env).length === 0) delete settings.env
  // 顶层 model 字段：仍是我们写的那个才还原（用户自己改过就留他的）
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

// ── 后台常驻 ────────────────────────────────────────────────────────────────

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** launchd 的 plist 文本；单独导出是为了能离线断言。 */
export function launchAgentPlist({ port, apiKey, env: extra = {}, node = process.execPath, cli = CLI_PATH, logDir }) {
  const env = {
    BRIDGE_PORT: String(port),
    ...apiKey === '' ? {} : { BRIDGE_API_KEY: apiKey },
    // 模式、上游、模型这些必须写进服务环境：服务是不带参数启动的，
    // 少了它们就会退回「直连模式 + 自动选模型」，与用户刚选的配置不一致。
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
${Object.entries(env).map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'bridge.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'bridge.err.log'))}</string>
</dict>
</plist>
`
}

export function systemdUnit({ port, apiKey, env: extra = {}, node = process.execPath, cli = CLI_PATH }) {
  const environment = [`Environment=BRIDGE_PORT=${port}`]
  if (apiKey !== '') environment.push(`Environment=BRIDGE_API_KEY=${apiKey}`)
  for (const [key, value] of Object.entries(extra)) environment.push(`Environment=${key}=${value}`)
  return `[Unit]
Description=claude-code-openai-bridge（Claude Code 的 WorkBuddy 反代）
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

function servicePaths() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return {
      kind: 'launchd',
      path: path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    }
  }
  if (process.platform === 'linux') {
    return {
      kind: 'systemd',
      path: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', `${SERVICE_LABEL}.service`),
    }
  }
  return { kind: 'unsupported', path: '' }
}

export function serviceState() {
  const { kind, path: file } = servicePaths()
  return { kind, path: file, installed: file !== '' && fs.existsSync(file), supported: kind !== 'unsupported' }
}

/**
 * 服务文件里真正被执行的**那份代码在哪**。
 *
 * 真实踩过：全局安装（`npm i -g` / 早期那份 npm link 拷贝）会把服务指向
 * `…/lib/node_modules/claude-code-openai-bridge/cli.mjs`，那是一条**快照** ——
 * 之后无论 `git pull` 还是改仓库，服务跑的都还是旧代码，而界面上完全看不出来
 * （表现是「新功能在命令行有、服务里没有」，或「修好的指纹在服务里还报 400」）。
 *
 * 所以这里直接把服务文件解析出来，供 `status` 与调用方对比当前 CLI 的路径。
 */
/** 从服务文件内容里取出被执行的 CLI 路径（纯函数，便于离线断言）。 */
export function cliPathFromServiceFile(text, kind) {
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

/** 本进程正在跑的那份代码。与服务文件里的路径一致才说明「服务跑的就是你改的这份」。 */
export function currentCliPath() {
  return CLI_PATH
}

/**
 * 装成开机自启的后台服务；返回它实际做了什么，供界面如实展示。
 *
 * ⚠️ **重启路径必须等 bootout 落地**。`launchctl bootout` 是异步的，紧接着
 * `bootstrap` 同一个 label 会失败成 `Bootstrap failed: 5: Input/output error`
 * —— 用户在菜单里第二次点「一键配置」时必然撞上（真实缺陷，2026-10-16 修复）。
 * 所以先轮询到它真的卸干净，再 bootstrap，并给 bootstrap 留几次重试。
 */
export async function installService({ port, apiKey, env = {} }) {
  const { kind, path: file } = servicePaths()
  if (kind === 'unsupported') {
    return { ok: false, kind, reason: `暂不支持 ${process.platform} 的自启，请自行把 \`node ${CLI_PATH}\` 放进你的启动项` }
  }
  const logDir = bridgeHome()
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, kind === 'launchd'
    ? launchAgentPlist({ port, apiKey, env, logDir })
    : systemdUnit({ port, apiKey, env }), { mode: 0o600 })
  const state = readInstallState()
  state.service = { kind, path: file, port, env, cliPath: CLI_PATH }
  writeInstallState(state)

  const notes = []
  try {
    if (kind === 'launchd') {
      const domain = `gui/${process.getuid()}`
      if (launchdLoaded(SERVICE_LABEL)) {
        try {
          execFileSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' })
        } catch { /* 已经没了也算成功 */ }
        for (let attempt = 0; attempt < 40 && launchdLoaded(SERVICE_LABEL); attempt++) await sleep(250)
      }
      let loaded = false
      for (let attempt = 0; attempt < 5 && !loaded; attempt++) {
        try {
          execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'pipe' })
          loaded = true
        } catch (error) {
          if (attempt === 4) throw error
          await sleep(400)
        }
      }
      notes.push('launchctl bootstrap 已加载')
    } else {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
      execFileSync('systemctl', ['--user', 'enable', '--now', `${SERVICE_LABEL}.service`], { stdio: 'pipe' })
      notes.push('systemctl --user enable --now 已完成')
    }
  } catch (error) {
    return { ok: false, kind, path: file, reason: `服务文件已写入 ${file}，但加载失败：${error?.message ?? error}` }
  }
  return { ok: true, kind, path: file, notes }
}

export function uninstallService() {
  const { kind, path: file } = servicePaths()
  if (file === '' || !fs.existsSync(file)) return { skipped: true, reason: '没有装过后台服务' }
  try {
    if (kind === 'launchd') execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'pipe' })
    else execFileSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_LABEL}.service`], { stdio: 'pipe' })
  } catch { /* 没在跑就算了，文件还是要删掉 */ }
  fs.rmSync(file, { force: true })
  const state = readInstallState()
  delete state.service
  writeInstallState(state)
  return { ok: true, kind, path: file }
}
