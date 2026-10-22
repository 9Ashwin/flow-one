/**
 * 配置解析：环境变量打底，命令行覆盖，子命令分流。
 *
 * 不写配置文件是有意的——这个桥的全部状态就是「用哪个上游、监听哪个端口」，
 * 放进环境变量既够用，也让把它塞进 Claude Code 的 settings.json 时只有一份真相。
 * 唯一的落盘文件是登录凭据（见 {@link credentialFile}）。
 *
 * @module src/config.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCE_NAMES, sourceByName, defaultSources } from './sources.mjs'
import { bridgeHome, credentialFile } from './home.mjs'

export const DEFAULTS = {
  /** `direct` = 自己登录腾讯产品；`gateway` = 转发给任意 OpenAI 兼容端点。 */
  mode: 'direct',
  host: '127.0.0.1',
  port: 8788,
  /** 网关模式的上游，默认指向 dsh-our-free-model 的渠道网关。 */
  upstream: 'http://127.0.0.1:8326',
  upstreamKey: '',
  /** 空 = 由上游模型清单决定（直连模式取第一个可用模型）。 */
  model: '',
  /** 本桥自己的门禁；留空表示只服务本机、不校验调用方。 */
  apiKey: '',
  /** `{"claude-haiku-4-5":"cn/deepseek-v4.1-flash"}` 形式的显式映射。 */
  modelMap: {},
  maxTokensCap: 0,
  showThinking: false,
  heartbeatMs: 15000,
  /** 是否对腾讯后端做已知内容指纹的窄改写（详见 src/fingerprint.mjs）。 */
  fingerprintRewrite: true,
  /** 同时挂载的来源，顺序决定「没有前缀的模型 ID」落到谁身上。 */
  products: defaultSources(),
  quiet: false,
}

/**
 * 本桥的默认口令。
 *
 * 本地回环（127.0.0.1）其实可以不要口令，但 Claude Code / DSH 的配置里都要填一个 token。
 * 所以给它一个**固定**的默认值，而不是每次 setup 现生成一把随机的：
 * 随机换钥匙会让已经填好的客户端配置（以及 DSH 凭据 seam 里的引用）当场失效 ——
 * 2026-10-22 真机就是这么坏的：DSH 里存着上一把 key，setup 一跑就「密钥无效」。
 *
 * 想换：`--api-key <x>` / `BRIDGE_API_KEY`；想彻底不要门禁：设成空（只监听回环）。
 */
export const DEFAULT_LOCAL_API_KEY = 'flow-one-local'

/** 网关模式下的默认模型：DSH 渠道网关里 WorkBuddy 国际版的常用模型。 */
const GATEWAY_DEFAULT_MODEL = 'workbuddy/deepseek-v4.1-flash'

const SUBCOMMANDS = new Set(['login', 'status', 'models', 'setup', 'uninstall', 'switch', 'doctor', 'client'])

/** 数据目录的位置住在 `home.mjs`（那里不 import 任何本项目模块，避免循环依赖）。 */
export { bridgeHome, credentialFile }

/**
 * dsh-our-free-model 的渠道网关把密钥放在 DSH home 下；网关模式未显式配置时
 * 按约定读取。读不到就当作没有（网关会回 401，用户一眼能看出是密钥没给）。
 */
export function readDshGatewayKey(env = process.env, home = os.homedir()) {
  const fromEnv = String(env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim()
  if (fromEnv !== '') return { key: fromEnv, path: null }
  const dshHome = String(env.DSH_HOME ?? '').trim() || path.join(home, '.dsh')
  const file = path.join(dshHome, 'openai-gateway', 'api-key')
  try {
    const key = fs.readFileSync(file, 'utf8').trim()
    if (key !== '') return { key, path: file }
  } catch { /* 没装过那个插件，或还没生成过密钥 */ }
  return { key: '', path: null }
}

export const USAGE = `flow-one —— 让 Claude Code CLI 用上 WorkBuddy（国内版 / 国际版）与 OpenCode 免费档

用法：
  flow-one                    启动反代
  flow-one login [cn|intl]    登录（不带产品名时两个都登）
  flow-one status             查看登录状态
  flow-one models             列出可用模型 ID
  flow-one switch             交互式换模型（改配置并重启服务）
  flow-one doctor             自检：配置 / 登录 / 两条门禁（会真发请求）
  flow-one setup              交互式一键配置（登录 → 选模型 → 配反代 → 可选帮你配客户端）
  flow-one client             打印接入信息（地址 / 令牌 / 模型 ID），自己填到客户端里
  flow-one uninstall          还原本工具写过的配置并卸载后台服务

选项：
  --mode <direct|gateway>  直连腾讯产品（默认），或转发给 OpenAI 兼容上游
  --product <cn|intl|oc|ocg>  只挂载指定的来源，可重复；默认挂已配好的全部
  --host <地址>            监听地址（默认 ${DEFAULTS.host}）
  --port <端口>            监听端口（默认 ${DEFAULTS.port}）
  --model <ID>             默认模型 ID；直连模式不给则由上游清单决定
  --map <A=B,C=D>          Claude 模型名 → 上游模型 ID 的显式映射
  --api-key <KEY>          本桥自己的门禁密钥（不传则不校验，仅监听回环）
                           setup 首次落固定默认值 flow-one-local，之后一直复用（不换钥匙）
  --json                   错误以一行 JSON 信封输出到 stderr（脚本用）
  --service / --no-service 后台常驻：显式表态（覆盖上次记住的选择）
  --clients <列表>         要帮你配哪些客户端：claude,dsh / claude / dsh / none
                           （默认问一次并记住；none = 只配反代，不动任何客户端文件）
                           旧写法 --client / --no-client 仍可用，等价 claude / none
  --version, -v            显示版本号
  --max-tokens <N>         下发前的 max_tokens 上限，0 表示不限制
  --heartbeat <毫秒>       思考期间的心跳间隔，0 关闭（默认 ${DEFAULTS.heartbeatMs}）
  --thinking               把上游的思考增量渲染成 thinking 块（默认丢弃）
  --no-fingerprint-rewrite 关闭腾讯侧内容指纹的窄改写（默认开启，见 README）
  --quiet                  只打印错误
  --help                   显示本帮助

网关模式专用：
  --upstream <URL>         OpenAI 兼容上游（默认 ${DEFAULTS.upstream}）
  --upstream-key <KEY>     上游密钥；不给时依次读 DSH_OPENAI_GATEWAY_API_KEY、
                           $DSH_HOME/openai-gateway/api-key

环境变量：BRIDGE_MODE / BRIDGE_PRODUCTS / BRIDGE_HOST / BRIDGE_PORT / BRIDGE_MODEL /
BRIDGE_API_KEY / BRIDGE_MODEL_MAP / BRIDGE_MAX_TOKENS_CAP / BRIDGE_SHOW_THINKING /
BRIDGE_HEARTBEAT_MS / BRIDGE_FINGERPRINT_REWRITE / BRIDGE_HOME / UPSTREAM_BASE_URL /
UPSTREAM_API_KEY
`

/** `--clients claude,dsh` / `none` → 目标集合。 */
function parseClients(raw) {
  const text = String(raw).trim().toLowerCase()
  if (text === '' || text === 'none') return []
  const out = []
  for (const item of text.split(',')) {
    const id = item.trim()
    if (id === '' || id === 'none') continue
    if (id !== 'claude' && id !== 'dsh') throw new Error(`未知的客户端：${id}（可选 claude / dsh / none）`)
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function parseModelMap(raw) {
  const map = {}
  for (const pair of String(raw).split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const from = pair.slice(0, at).trim()
    const to = pair.slice(at + 1).trim()
    if (from !== '' && to !== '') map[from] = to
  }
  return map
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

/** 来源名列表 → 来源对象；未知名字直接报错，不做静默回退。 */
function resolveSources(names) {
  const picked = []
  for (const name of names) {
    const source = sourceByName(name)
    if (source === undefined) throw new Error(`未知来源：${name}（可选 ${SOURCE_NAMES}）`)
    if (!picked.includes(source)) picked.push(source)
  }
  return picked.length > 0 ? picked : defaultSources()
}

const FLAGS = {
  '--mode': 'mode',
  '--host': 'host',
  '--port': 'port',
  '--model': 'model',
  '--api-key': 'apiKey',
  '--map': 'modelMap',
  '--max-tokens': 'maxTokensCap',
  '--fingerprint-rewrite': 'fingerprintRewrite',
  '--heartbeat': 'heartbeatMs',
  '--upstream': 'upstream',
  '--upstream-key': 'upstreamKey',
  '--product': 'product',
  '--products': 'products',
}

/**
 * 解析命令行。
 *
 * @returns {{help: boolean, command: string, commandArgs: string[], config: object}}
 */
export function resolveConfig({ env = process.env, argv = [], home = os.homedir() } = {}) {
  const config = { ...DEFAULTS, products: [...DEFAULTS.products], modelMap: {} }
  const productNames = []
  const fromEnv = {
    mode: env.BRIDGE_MODE,
    host: env.BRIDGE_HOST,
    port: env.BRIDGE_PORT,
    upstream: env.UPSTREAM_BASE_URL,
    upstreamKey: env.UPSTREAM_API_KEY,
    model: env.BRIDGE_MODEL,
    apiKey: env.BRIDGE_API_KEY,
    heartbeatMs: env.BRIDGE_HEARTBEAT_MS,
  }
  for (const [key, value] of Object.entries(fromEnv)) {
    if (value === undefined || String(value).trim() === '') continue
    config[key] = key === 'port' || key === 'heartbeatMs' ? Number(value) : String(value).trim()
  }
  if (String(env.BRIDGE_MODEL_MAP ?? '').trim() !== '') config.modelMap = parseModelMap(env.BRIDGE_MODEL_MAP)
  if (String(env.BRIDGE_MAX_TOKENS_CAP ?? '').trim() !== '') config.maxTokensCap = Number(env.BRIDGE_MAX_TOKENS_CAP)
  if (env.BRIDGE_SHOW_THINKING !== undefined) config.showThinking = truthy(env.BRIDGE_SHOW_THINKING)
  if (env.BRIDGE_FINGERPRINT_REWRITE !== undefined) config.fingerprintRewrite = truthy(env.BRIDGE_FINGERPRINT_REWRITE)
  if (String(env.BRIDGE_PRODUCTS ?? '').trim() !== '') productNames.push(...String(env.BRIDGE_PRODUCTS).split(','))

  const rest = []
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') return { help: true, command: 'help', commandArgs: [], config }
    if (flag === '--thinking') { config.showThinking = true; continue }
    if (flag === '--no-fingerprint-rewrite') { config.fingerprintRewrite = false; continue }
    if (flag === '--setup' || flag === '--uninstall') { rest.push(flag.slice(2)); continue }
    if (flag === '--quiet') { config.quiet = true; continue }
    // 三个「出现即生效」、不接参数的开关：
    //   --json        错误渲染成一行 JSON 信封（脚本用；cli.mjs 在解析前也要认它，
    //                 否则连「参数写错了」都没法输出 JSON —— 两边读的是同一份 argv，不冲突）
    //   --service / --no-service  对「要不要后台常驻」显式表态，覆盖上次记住的选择
    if (flag === '--json') { config.json = true; continue }
    if (flag === '--service') { config.service = true; continue }
    if (flag === '--no-service') { config.service = false; continue }
    // 帮哪些客户端写配置：只是顺手帮忙，不写也照样能跑反代。显式表态优先，不落账本
    // （落账本的是向导问的那一次，见 install.mjs 的 clientChoice）
    if (flag === '--clients') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error('--clients 缺少参数（claude,dsh / claude / dsh / none）')
      config.clients = parseClients(value)
      continue
    }
    // 兼容旧写法：--client 等价 --clients claude，--no-client 等价 --clients none
    if (flag === '--client') { config.clients = ['claude']; continue }
    if (flag === '--no-client') { config.clients = []; continue }
    if (!flag.startsWith('--')) { rest.push(flag); continue }
    const field = FLAGS[flag]
    if (field === undefined) throw new Error(`未知选项：${flag}（--help 查看用法）`)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少参数`)
    if (field === 'port' || field === 'maxTokensCap' || field === 'heartbeatMs') {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 0) throw new Error(`${flag} 需要非负整数`)
      config[field] = number
    } else if (field === 'fingerprintRewrite') {
      config.fingerprintRewrite = truthy(value)
    } else if (field === 'modelMap') {
      config.modelMap = { ...config.modelMap, ...parseModelMap(value) }
    } else if (field === 'product' || field === 'products') {
      productNames.push(...String(value).split(','))
    } else {
      // 显式给了 --upstream 就是在说「我要网关模式」，不必再让人多敲一个开关。
      if (field === 'upstream') config.mode = 'gateway'
      config[field] = value.trim()
    }
  }

  const command = rest[0] ?? 'serve'
  const commandArgs = rest.slice(1)
  if (command !== 'serve' && !SUBCOMMANDS.has(command)) {
    throw new Error(`未知子命令：${command}（可选 ${[...SUBCOMMANDS].join(' / ')}）`)
  }
  if (config.mode !== 'direct' && config.mode !== 'gateway') {
    throw new Error(`--mode 只能是 direct 或 gateway，收到：${config.mode}`)
  }
  config.products = resolveSources(productNames)
  config.credentialFile = credentialFile(env, home)
  config.home = bridgeHome(env, home)

  if (config.mode === 'gateway') {
    try {
      const url = new URL(config.upstream)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new Error(`上游地址不是合法的 http(s) URL：${config.upstream}`)
    }
    config.upstream = config.upstream.replace(/\/+$/, '')
    if (config.upstreamKey === '') {
      const found = readDshGatewayKey(env, home)
      config.upstreamKey = found.key
      config.upstreamKeyPath = found.path
    }
    // 只有「没指定上游」也就是默认那条 DSH 网关时，才替用户选好 WorkBuddy 的
    // 常用模型；指向别家（Ollama、官方 API……）时留给模型清单自动决定。
    if (config.model === '' && config.upstream === DEFAULTS.upstream) config.model = GATEWAY_DEFAULT_MODEL
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('端口必须是 0 到 65535 之间的整数')
  }
  return { help: false, command, commandArgs, config }
}
