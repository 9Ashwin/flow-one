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
import { writeFileAtomic } from './atomic.mjs'

const CLI_PATH = fileURLToPath(new URL('../cli.mjs', import.meta.url))

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** launchd 里这个 label 是否已加载。 */
function launchdLoaded(label) {
  try {
    platformRun('launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/**
 * 平台命令的统一入口。
 *
 * ⚠️ **测试进程里绝不真执行**：`launchctl` / `systemctl` 都是按 **label** 操作的，
 * 而 label 是全机器共享的 —— 测试里即使把 HOME 指到临时目录，一次
 * `bootout gui/501/dev.claude-code-openai-bridge` 仍然会把用户**真实**的服务停掉
 * （文件在临时目录所以文件还在，服务却没了，表现是 Claude Code 突然 ECONNREFUSED）。
 * 真出过这个事故，所以这里做成「测试里只记录意图」：
 * 想看调用序列就断言 `serviceCalls`，想真跑就在非测试进程里跑。
 */
export const serviceCalls = []

/**
 * `execFileSync` 的输出统一成字符串。
 *
 * ⚠️ `stdio: 'ignore'` 时它返回的是 **null**，不是空字符串 —— 直接 `.toString()`
 * 会抛 `TypeError: Cannot read properties of null`。
 */
export function commandOutput(result) {
  return result === null || result === undefined ? '' : `${result}`
}

function platformRun(command, args, options = {}) {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    serviceCalls.push({ command, args })
    return ''
  }
  // 真机上撞到过（2026-10-20）：这里原来是 `execFileSync(...).toString()`。
  // 而 `launchdLoaded` 用的是 `stdio: 'ignore'`（成功调用返回 null）→ 成功也抛 TypeError
  // → 被 catch 当成「没加载」。后果是 installService 跳过 bootout、bootstrap 撞上
  // `Bootstrap failed: 5: Input/output error` 失败返回 ok:false，**旧进程带着旧 API key
  // 继续跑**：用户看到的是「配置明明写好了，Claude Code 却一直 401」。
  return commandOutput(execFileSync(command, args, options))
}

export const SERVICE_LABEL = 'dev.flow-one'
/**
 * 改名前的服务名。
 *
 * 不清掉它，就会出现「旧服务还在跑、新服务又装一个」—— 两个进程抢同一个端口
 * （谁赢取决于启动顺序），表现是服务时好时坏，而界面上完全看不出来。
 */
export const LEGACY_SERVICE_LABEL = 'dev.claude-code-openai-bridge'

/**
 * `/health` 里 `service` 字段认哪些名字。
 *
 * 改名之后**必须同时认旧的**：正在跑的可能是改名之前装的那份（全局 npm 包），
 * 它自报的还是旧名字。只认新名字会把「服务明明在跑」判成「没人监听」——
 * 真机上就撞到过：doctor 报 ✘「配置指向的端口上没有服务在跑」，而 `claude` 其实是通的。
 */
export const HEALTH_SERVICE_NAMES = new Set(['flow-one', 'claude-code-openai-bridge'])

/**
 * `systemctl --user` 要用的 `XDG_RUNTIME_DIR`。
 *
 * 真实踩过（2026-10-16）：SSH 进来或非登录壳里这个变量常常是空的，于是
 * `systemctl --user` 一律报 `Failed to connect to bus: No medium found`。表现是
 * 向导说「配置已写入」、单元文件却从没落地、8788 上没人听 —— 用户回到 Claude Code
 * 只看到 ECONNREFUSED，而真正的错在安装那一步就被吞掉了。
 *
 * dbus 其实一直在 `/run/user/<uid>/bus`，只是没人把路径指出来（`/run/user/<uid>`
 * 存在就说明用户会话是有的）。这里直接补上；纯函数，便于离线断言。
 */
export function xdgRuntimeDir(env = process.env, { uid = process.getuid?.(), exists = fs.existsSync } = {}) {
  const current = String(env.XDG_RUNTIME_DIR ?? '').trim()
  if (current !== '') return current
  // 拿不到 uid 就别拼 `/run/user/undefined`（Windows 上 `process.getuid` 根本不存在）
  if (!Number.isInteger(uid)) return undefined
  const fallback = `/run/user/${uid}`
  return exists(fallback) ? fallback : undefined
}

/** 带上补好的 `XDG_RUNTIME_DIR` 再调 `systemctl --user`。 */
function systemctl(args, env = process.env) {
  const dir = xdgRuntimeDir(env)
  return platformRun('systemctl', ['--user', ...args], {
    stdio: 'pipe',
    env: dir === undefined ? env : { ...env, XDG_RUNTIME_DIR: dir },
  })
}

/**
 * 服务加载失败时的说法。
 *
 * dbus 连不上的报错原文（`Failed to connect to bus: No medium found`）对用户没有
 * 任何指导性，容易被当成「本工具不支持这台机器」而放弃。单独识别这一类，直接给
 * 可执行的两条路。其余错误原样带出，不掩盖真因。
 */
export function serviceLoadReason(message, file) {
  const text = String(message ?? '')
  if (/Failed to connect to bus|No medium found|System has not been booted with systemd/i.test(text)) {
    return `服务文件已写入 ${file}，但这台机器上没有可用的 systemd 用户会话（${text}）。`
      + '要么先 `loginctl enable-linger $USER` 然后重进登录壳，要么直接前台跑 `fo`。'
  }
  return `服务文件已写入 ${file}，但加载失败：${text}`
}

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
  // 临时文件 + rename：账本是「记过什么」的唯一凭据，半个 JSON 等于把记录弄丢
  writeJsonAtomic(file, state, 0o600)
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

/**
 * 账本与 `settings.json` 都走这里落盘。
 *
 * 「临时文件 + rename」的跨平台代价（Windows 上目标被占用就 EPERM）收在
 * {@link writeFileAtomic} 里，这里只负责 JSON 的形状。
 */
function writeJsonAtomic(file, value, mode = 0o600) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
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
 * `[1m]` 后缀按**模型真实窗口**决定：超过 200k 才加。那是 Claude Code 自己的
 * 「按 1M 上下文登记」标记；给一个 200k 的模型加它，会让 Claude Code 到 1M 才压缩
 * 上下文，然后撞上模型真实上限（OpenCode 免费档的 deepseek-v4.1-flash-free 就是
 * 200k）。窗口未知时按不加处理 —— Claude Code 对未识别 ID 的默认假设正是 200k。
 *
 * 单独导出是因为「不写客户端配置」那条路也要把这个**裸/带后缀**的 ID 打给用户
 * （让他自己填），两边必须是同一个算法。
 */
export function sizedModelId(model, contextWindow) {
  const base = String(model ?? '').replace(/\[1m\]$/, '')
  const wants1M = String(model ?? '').endsWith('[1m]')
    || (Number.isFinite(contextWindow) && contextWindow > 200_000)
  return wants1M ? `${base}[1m]` : base
}

/**
 * 把反代的接入参数写进 Claude Code 的 settings.json。
 *
 * 顺带说明为什么**不**写 `modelOverrides`：官方给的消诊断办法是把键写成
 * Claude 的模型 ID（等于让 Claude Code 以为自己在跑 Opus），代价是它随之套用
 * 那个模型的窗口与行为，不值得为一行 stderr 噪声付。
 *
 * @param {{file?: string, baseUrl: string, apiKey: string, model: string, contextWindow?: number}} options
 */
export function installClaudeSettings(options) {
  const file = options.file ?? claudeSettingsPath()
  const settings = readJson(file)
  const backupPath = backup(file)
  // 它发请求前会把后缀剥掉，上游收到的永远是裸 ID。
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
Description=flow-one（Claude Code 的 WorkBuddy 反代）
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

function servicePathsFor(label) {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return {
      kind: 'launchd',
      path: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    }
  }
  if (process.platform === 'linux') {
    return {
      kind: 'systemd',
      path: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', `${label}.service`),
    }
  }
  return { kind: 'unsupported', path: '' }
}

function servicePaths() {
  return servicePathsFor(SERVICE_LABEL)
}

/**
 * 测试进程里**不允许**操作真实的服务文件。
 *
 * 真出过事故：一个演示脚本只把 `BRIDGE_HOME` 指到临时目录、忘了 `HOME`，
 * 它调的 `uninstallService()` 于是对**真实**的 launchd 服务发了 bootout 并删掉了
 * plist —— 用户的 Claude Code 当场 ECONNREFUSED。这类错误不该靠人记得隔离，
 * 应该由代码拒绝：测试进程（Node 测试运行器会设 NODE_TEST_CONTEXT）里，
 * 服务文件必须落在系统临时目录下，否则直接抛。
 */
function assertScratchServicePath(paths) {
  if (process.env.NODE_TEST_CONTEXT === undefined) return
  if (paths.path === '') return
  // 用**字符串前缀**比较，不去 realpath 父目录：父目录通常还不存在，
  // realpathSync 会抛，而我第一版把那个异常当成「安全」直接放行了 —— 守卫于是形同虚设。
  // macOS 上 /var 与 /private/var 是同一处的两种写法，所以两个根都认。
  const roots = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map(root => (root.endsWith('/') ? root : `${root}/`))
  if (!roots.some(root => paths.path.startsWith(root))) {
    throw new Error(
      `测试里不允许操作真实服务文件：${paths.path}\n` +
      '把 HOME（不只是 BRIDGE_HOME）指到临时目录再跑。',
    )
  }
}

/** 改名前的服务文件位置（存在就说明是改名之前装的）。 */
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
    // 单独报出来：新名字的服务文件不存在时界面上是「未安装」，
    // 可旧服务其实还在跑、占着端口 —— 这个状态最容易被误读。
    legacyInstalled: legacy.path !== '' && fs.existsSync(legacy.path),
    supported: kind !== 'unsupported',
  }
}

/**
 * 账本里记的「要不要装成开机自启」这一问的答案。
 *
 * 交互式配置会反复跑（再挂一家、换个模型都要跑一遍），问过就别再问第二遍
 * —— 用户明确抱怨过「装过一次之后每次配置都还要再问一遍要不要开机自启」。
 * 这里只读写答案，**问不问、怎么问**由向导决定（这一层不做交互）。
 */
export function serviceChoice() {
  const state = readInstallState()
  return { asked: state.autoStartAsked === true, autoStart: state.autoStart === true }
}

/** 记下这一问的答案：下次配置据此不再问。 */
export function recordServiceChoice(autoStart) {
  const state = readInstallState()
  state.autoStart = autoStart === true
  state.autoStartAsked = true
  writeInstallState(state)
}

/**
 * 账本里记的「要不要帮你写客户端配置」这一问的答案。
 *
 * 这个工具的本分是**提供反代**；改用户的 `~/.claude/settings.json` 只是顺手帮忙。
 * 帮不帮，答案记在这儿：问过的就不再问，选过「不写」的也别再碰人家的文件
 * （Windows 上还可能撞权限，见 2026-10-19 那次 EPERM）。
 */
export function clientChoice() {
  const state = readInstallState()
  return { asked: state.clientConfigAsked === true, writeClient: state.clientConfig === true }
}

/** 记下这一问的答案：下次配置据此不再问。 */
export function recordClientChoice(writeClient) {
  const state = readInstallState()
  state.clientConfig = writeClient === true
  state.clientConfigAsked = true
  writeInstallState(state)
}

/**
 * 本次配置的接入参数（端口 / 令牌 / 模型）。
 *
 * 与「写不写客户端配置」无关：选了不写的人也要有地方拿到令牌（`fo client` 打印它，
 * 前台跑桥也要用它）。写进账本的 `bridge` 段。
 */
export function bridgeRecord() {
  const record = readInstallState().bridge
  return record !== null && typeof record === 'object' ? record : {}
}

export function recordBridge({ port, apiKey, model }) {
  const state = readInstallState()
  state.bridge = { port, apiKey, model, savedAt: new Date().toISOString() }
  writeInstallState(state)
}

/**
 * 清掉改名前的旧服务：先让它从 launchd / systemd 里退出来，再删服务文件。
 *
 * 卸载失败也照样删文件：留下一个「还在跑、却已经没有服务文件」的进程，
 * 比留下一个能被下次卸载清掉的文件更糟。
 */
export function removeLegacyService() {
  const { kind, path: file } = legacyServicePaths()
  assertScratchServicePath(legacyServicePaths())
  if (kind === 'unsupported' || file === '' || !fs.existsSync(file)) return { removed: false }
  try {
    if (kind === 'launchd') {
      try {
        platformRun('launchctl', ['bootout', `gui/${process.getuid()}/${LEGACY_SERVICE_LABEL}`], { stdio: 'ignore' })
      } catch { /* 没加载过就算了 */ }
    } else {
      try {
        systemctl(['--user', 'disable', '--now', `${LEGACY_SERVICE_LABEL}.service`])
      } catch { /* 没装过就算了 */ }
    }
  } catch { /* 上面已经各自兜过，这里只为保证不把安装流程带崩 */ }
  try {
    fs.rmSync(file)
  } catch {
    return { removed: false, path: file }
  }
  return { removed: true, path: file }
}

/**
 * 服务文件里真正被执行的**那份代码在哪**。
 *
 * 真实踩过：全局安装（`npm i -g` / 早期那份 npm link 拷贝）会把服务指向
 * `…/lib/node_modules/flow-one/cli.mjs`，那是一条**快照** ——
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
  assertScratchServicePath(servicePaths())
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
  // 装新的之前先清改名前的旧服务：两个都活着就会抢同一个端口
  const legacy = removeLegacyService()
  if (legacy.removed) notes.push(`已清理改名前的旧服务 ${LEGACY_SERVICE_LABEL}（避免新旧两个服务抢同一个端口）`)
  try {
    if (kind === 'launchd') {
      const domain = `gui/${process.getuid()}`
      if (launchdLoaded(SERVICE_LABEL)) {
        try {
          platformRun('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' })
        } catch { /* 已经没了也算成功 */ }
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
      notes.push('launchctl bootstrap 已加载')
    } else {
      systemctl(['daemon-reload'])
      systemctl(['enable', '--now', `${SERVICE_LABEL}.service`])
      notes.push('systemctl --user enable --now 已完成')
    }
  } catch (error) {
    return { ok: false, kind, path: file, reason: serviceLoadReason(error?.message ?? error, file) }
  }
  return { ok: true, kind, path: file, notes }
}

export function uninstallService() {
  const { kind, path: file } = servicePaths()
  assertScratchServicePath(servicePaths())
  // 改名前的旧服务也要带走：卸载就该什么都不剩
  const legacy = removeLegacyService()
  // 「装成开机自启」那一问也跟着忘掉：用户既然来卸载，下次配置就该重新问一遍。
  // 这在「没装过服务」的提前返回**之前**做 —— 上次在向导里选了「不装」的用户
  // 同样答过这一问，卸载之后不该还留着他的答案。
  // 「要不要写客户端配置」同理：卸载之后是一张白纸。
  const state = readInstallState()
  const remembered = 'service' in state || 'autoStart' in state || 'autoStartAsked' in state
    || 'clientConfig' in state || 'clientConfigAsked' in state || 'bridge' in state
  delete state.service
  delete state.autoStart
  delete state.autoStartAsked
  delete state.clientConfig
  delete state.clientConfigAsked
  delete state.bridge
  // 什么都没记过就别写：不为了「没删到东西」凭空造一个 install.json
  if (remembered) writeInstallState(state)
  if (file === '' || !fs.existsSync(file)) {
    return legacy.removed
      ? { ok: true, kind, path: legacy.path, legacy: true }
      : { skipped: true, reason: '没有装过后台服务' }
  }
  try {
    if (kind === 'launchd') platformRun('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'pipe' })
    else systemctl(['disable', '--now', `${SERVICE_LABEL}.service`])
  } catch { /* 没在跑就算了，文件还是要删掉 */ }
  fs.rmSync(file, { force: true })
  return { ok: true, kind, path: file }
}
