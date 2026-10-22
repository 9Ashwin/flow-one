/**
 * 终端界面组件（零依赖）。
 *
 * 形态对齐 [zcf](https://github.com/UfoMiao/zcf)：**开机 banner → 分区编号清单 →
 * 输入编号**，而不是把一屏选项塞进方向键列表。清单用打印出来（不是 TUI 重绘），
 * 所以在任何终端、任何 `| tee` 管道里都能看清；只有列表型挑选（模型清单）才用
 * 方向键 + 编号的交互选择。
 *
 * 只用 `node:readline` 与 ANSI 转义序列，不引第三方库：这个项目的卖点之一是
 * `git clone` 完直接 `node cli.mjs` 就能跑。
 *
 * @module src/prompt.mjs
 */

import readline from 'node:readline'
import process from 'node:process'

const ESC = '\x1b['
export const style = {
  bold: text => `${ESC}1m${text}${ESC}22m`,
  dim: text => `${ESC}2m${text}${ESC}22m`,
  cyan: text => `${ESC}36m${text}${ESC}39m`,
  green: text => `${ESC}32m${text}${ESC}39m`,
  yellow: text => `${ESC}33m${text}${ESC}39m`,
  red: text => `${ESC}31m${text}${ESC}39m`,
  gray: text => `${ESC}90m${text}${ESC}39m`,
}

/** 颜色助手也单独导出：调用方直接 `import { green }` 比每次写 `style.green` 顺手。 */
export const { bold, dim, cyan, green, yellow, red, gray } = style

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * 输入流接缝（**仅测试用**）。
 *
 * 用例需要「假装自己是 TTY 并逐键投喂」。早先的做法是直接改 `process.stdin`，
 * 结果是 node:test 的结果记账被搅乱 —— 往同一个文件里加一条这样的用例，整个文件
 * 的用例计数反而变少，日志里看不出任何异常。改成在这里换一根管子：谁都不碰全局。
 */
let stdinOverride = null
export function setStdinForTest(stream) {
  stdinOverride = stream
}
const stdinOf = () => stdinOverride ?? process.stdin

function clearLines(count) {
  if (count <= 0) return
  process.stdout.write(`${ESC}${count}A`)
  for (let i = 0; i < count; i++) process.stdout.write(`${ESC}2K\n`)
  process.stdout.write(`${ESC}${count}A`)
}

// ── 宽度计算 ────────────────────────────────────────────────────────────────

/** 中日韩字符与全角标点占两列；画框与对齐都靠它，否则中文标题会把框撑歪。 */
/** 终端颜色码：算宽度前必须先剥掉，否则它会按可见字符计数，把边框撑歪。 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g

export function displayWidth(text) {
  let width = 0
  for (const char of String(text).replace(ANSI_PATTERN, '')) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  }
  return width
}

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

// ── 输出块 ──────────────────────────────────────────────────────────────────

export const note = text => { process.stdout.write(`${text}\n`) }
export const blank = () => { process.stdout.write('\n') }
export const rule = (width = 46) => note(dim('─'.repeat(width)))
export const heading = text => note(`\n${bold(text)}`)
export const success = text => note(`${green('✔')} ${text}`)
export const warn = text => note(`${yellow('!')} ${text}`)
export const fail = text => note(`${red('✘')} ${text}`)
export const info = text => note(`${cyan('›')} ${text}`)

/** zcf 那种分区小标题：`──────── 维护 ────────`。 */
export function section(title) {
  note(`  ${dim(`──────── ${title} ────────`)}`)
}

/** 画一个框，内容按显示宽度对齐（中文占两列的账已经算过）。 */
export function box(lines, { color = cyan } = {}) {
  // 内部宽度 = 最长一行 + 左右各一个空格；正文按 (width-1) 补齐，
  // 因为前面那个空格也算在内部宽度里。
  const width = Math.max(...lines.map(line => displayWidth(line)), 0) + 2
  note(color(`  ╭${'─'.repeat(width)}╮`))
  for (const line of lines) note(`${color('  │')} ${pad(line, width - 1)}${color('│')}`)
  note(color(`  ╰${'─'.repeat(width)}╯`))
}

/** 项目 banner：名字 + 版本 + 一句话说明，和 zcf 的开机块同一个位置。 */
export function banner(subtitle, version = '') {
  blank()
  box([
    `flow-one${version === '' ? '' : `  ${version}`}`,
    subtitle,
  ])
}

// ── 交互 ────────────────────────────────────────────────────────────────────

/** 跑一个按键循环，把渲染交给 `render()`。收尾一定要恢复光标与 raw mode。 */
function keyLoop({ render, onKey, cleanupLines }) {
  const stdin = stdinOf()
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()
  process.stdout.write(`${ESC}?25l`)
  let drawn = 0
  const draw = () => {
    clearLines(drawn)
    const lines = render()
    process.stdout.write(`${lines.join('\n')}\n`)
    drawn = lines.length
  }
  return new Promise((resolve, reject) => {
    const restore = () => {
      stdin.removeListener('keypress', listener)
      process.stdout.write(`${ESC}?25h`)
      if (!wasRaw) stdin.setRawMode?.(false)
      stdin.pause()
    }
    const finish = value => {
      restore()
      cleanupLines?.(drawn)
      resolve(value)
    }
    const listener = (str, key) => {
      if (key?.ctrl && key.name === 'c') {
        restore()
        process.stdout.write(`\n${yellow('已取消')}\n`)
        process.exit(130)
      }
      try {
        if (onKey(str, key ?? {}, finish) === true) return
        draw()
      } catch (error) {
        restore()
        process.stdout.write('\n')
        reject(error)
      }
    }
    stdin.on('keypress', listener)
    draw()
  })
}

/**
 * 打印式编号菜单（zcf 的主菜单形态）。
 *
 * 选项**打印出来**再输入编号，而不是在 TUI 里上下移动：一屏看得全，
 * 复制到对话或日志里也不丢上下文。
 *
 * @param {{title: string, groups: Array<{title?: string, items: Array<{key: string, label: string, hint?: string, danger?: boolean}>}>}} spec
 */
export async function menu({ title, groups }) {
  note(`\n${bold(title)}`)
  const keys = []
  for (const group of groups) {
    if (group.title !== undefined) section(group.title)
    for (const item of group.items) {
      keys.push(item.key, item.key.toUpperCase())
      const key = item.danger === true ? red(`${item.key}.`) : cyan(`${item.key}.`)
      const hint = item.hint === undefined || item.hint === '' ? '' : `  ${gray(item.hint)}`
      note(`  ${key} ${item.label}${hint}`)
    }
    blank()
  }
  const normalized = value => value.toLowerCase()
  const allowed = new Set(keys.map(normalized))
  const answer = await input({
    message: '请输入编号',
    validate: value => (allowed.has(normalized(value)) ? undefined : `请输入 ${groups.flatMap(g => g.items.map(i => i.key)).join(' / ')}`),
  })
  return answer.trim().toUpperCase()
}

/**
 * 列表挑选：方向键或编号。
 *
 * 编号规则（长清单也够用）：按下的数字若能再接一位仍构成合法编号就继续攒着，
 * 否则立即选中 —— 5 个选项按 `1` 直接选中，13 个选项按 `1` 先移动光标、
 * 再按 `3` 得到第 13 个，或按 `1` 后回车选第 1 个。
 */
/** 选项的可搜索文本：标签、值与提示都算，省得用户猜该搜哪个字段。 */
const searchTextOf = option => `${option.label ?? ''} ${option.value ?? ''} ${option.hint ?? ''}`.toLowerCase()

/**
 * 列表选择。
 *
 * `filterable: true` 时**直接敲字就筛**、边打边出结果（不用先选「筛选」再输入）：
 * 可打印字符进查询串，退格删一个字，Esc 清空，↑↓ 在结果里移动，回车确认。
 * 上百条的模型清单离了它没法用 —— 所以这一档里 `j`/`k` 是普通字符，不当方向键。
 *
 * 结果超过 `windowSize` 时只画光标附近那一段，并标出总条数：清单再长也不会把
 * 屏幕刷掉。默认（`filterable: false`）保持原来的形态：全量列出 + 数字直选。
 *
 * 选项带 `separator: true` 时只作分组标题：不编号、不可选、光标跳过；一敲字筛选
 * 就把它们去掉 —— 筛选结果里再插分组标题只会误导。
 */
export async function select({ message, options, initial = 0, filterable = false, windowSize = 12 }) {
  if (options.length === 0) throw new Error('select 需要至少一个选项')
  // 光标不落在禁用项（「还没登录」这类，选下去只会再报一次错）与分组标题上：
  // 落在标题上会让第一次按下方向键看起来「没反应」。
  const firstEnabled = (list, from = 0) => {
    if (list.length === 0) return 0
    let index = Math.min(Math.max(from, 0), list.length - 1)
    for (let step = 0; step < list.length; step++) {
      if (list[index]?.disabled !== true && list[index]?.separator !== true) break
      index = (index + 1) % list.length
    }
    return index
  }
  const isReal = option => option !== undefined && option.separator !== true
  let query = ''
  let visible = options
  let cursor = firstEnabled(options, initial)
  let typed = ''
  const numberWidth = String(options.length).length
  const done = (option, finish) => {
    finish(option.value)
    note(`${green('✔')} ${message} ${bold(option.label)}`)
    return true
  }
  const realCount = list => list.filter(isReal).length
  const applyQuery = () => {
    const needle = query.trim().toLowerCase()
    // 筛选时丢掉分组标题：结果里再插「免费模型 / 其余模型」只会误导
    visible = needle === ''
      ? options
      : options.filter(option => isReal(option) && searchTextOf(option).includes(needle))
    cursor = firstEnabled(visible)
  }
  /** 上下移动时跳过分组标题（它们在 filterable 模式下不参与选择）。 */
  const step = delta => {
    if (visible.length === 0) return
    let next = cursor
    for (let i = 0; i < visible.length; i++) {
      next = (next + delta + visible.length) % visible.length
      if (isReal(visible[next])) { cursor = next; return }
    }
  }
  const hint = filterable ? '直接敲字筛选，↑↓ 选择，回车确认' : '↑↓ 选择，或直接按编号，回车确认'
  note(`${cyan('?')} ${message}  ${dim(hint)}`)
  return await keyLoop({
    cleanupLines: clearLines,
    render: () => {
      const lines = []
      if (filterable) {
        lines.push(query === ''
          ? `  ${dim(`直接敲字筛选 · 共 ${realCount(options)} 项`)}`
          : `  ${cyan('筛选')} ${bold(query)}  ${dim(`${realCount(visible)}/${realCount(options)} 项`)}`)
      }
      if (visible.length === 0) {
        lines.push(`  ${yellow('没有匹配项')}  ${dim('退格删字，Esc 清空')}`)
        return lines
      }
      const size = filterable ? Math.min(windowSize, visible.length) : visible.length
      const start = Math.min(Math.max(cursor - Math.floor(size / 2), 0), Math.max(0, visible.length - size))
      const digits = String(Math.max(realCount(visible), 1)).length
      let ordinal = visible.slice(0, start).filter(isReal).length
      for (let index = start; index < start + size; index++) {
        const option = visible[index]
        if (option.separator === true) {
          lines.push(dim(`  ──── ${option.label} ────`))
          continue
        }
        ordinal += 1
        const active = index === cursor
        const text = `${String(ordinal).padStart(digits)}. ${option.label}`
        const pointer = active ? cyan('❯') : ' '
        const suffix = option.hint === undefined || option.hint === '' ? '' : `  ${dim(option.hint)}`
        lines.push(`${pointer} ${option.disabled === true || !active ? dim(text) : text}${suffix}`)
      }
      if (start > 0 || start + size < visible.length) {
        const hidden = realCount(visible) - visible.slice(start, start + size).filter(isReal).length
        lines.push(dim(`  … 还有 ${hidden} 项（继续敲字缩小范围）`))
      }
      return lines
    },
    onKey: (str, key, finish) => {
      const name = key.name
      if (name === 'up') { typed = ''; step(-1) }
      else if (name === 'down') { typed = ''; step(1) }
      else if (filterable && (name === 'backspace' || name === 'delete')) { query = query.slice(0, -1); applyQuery() }
      else if (filterable && name === 'escape') { query = ''; applyQuery() }
      else if (name === 'return' || name === 'enter') {
        const option = visible[cursor]
        if (option !== undefined && option.disabled !== true) return done(option, finish)
      } else if (filterable) {
        // 可打印字符一律进查询串：模型 ID 里的字母、数字、点、横线都能搜
        if (typeof str === 'string' && str.length > 0 && key.ctrl !== true && key.meta !== true && str >= ' ') {
          query += str
          applyQuery()
        }
      } else if (name === 'left' || str === 'k') { typed = ''; cursor = (cursor - 1 + visible.length) % visible.length }
      else if (name === 'right' || str === 'j') { typed = ''; cursor = (cursor + 1) % visible.length }
      else if (name === 'backspace') typed = typed.slice(0, -1)
      else if (/^\d$/.test(str)) {
        const next = typed + str
        const index = Number(next) - 1
        if (index < options.length && next.length <= numberWidth) {
          typed = next
          cursor = index
          if (Number(next) * 10 > options.length) {
            const option = options[index]
            if (option.disabled !== true) return done(option, finish)
          }
        }
      }
      return false
    },
  })
}

/**
 * 密钥输入：键入的字符回显成 `*`。
 *
 * 密钥要落到凭据文件里，不该留在终端回滚缓冲里被人瞄到 —— 所以单独一个组件，
 * 而不是拿 `input()` 凑合。
 */
export async function password({ message, validate }) {
  const stdin = stdinOf()
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()
  let value = ''
  const render = () => `${cyan('?')} ${message} ${value === '' ? dim('粘贴后回车') : '*'.repeat(Math.min(value.length, 24))}`
  process.stdout.write(render())
  return await new Promise((resolve, reject) => {
    const restore = () => {
      stdin.removeListener('keypress', listener)
      if (!wasRaw) stdin.setRawMode?.(false)
      stdin.pause()
    }
    const repaint = () => {
      process.stdout.write(`\r${ESC}2K${render()}`)
    }
    const listener = (str, key) => {
      try {
        if (key?.ctrl && key.name === 'c') {
          restore()
          process.stdout.write(`\n${yellow('已取消')}\n`)
          process.exit(130)
        }
        const name = key?.name
        if (name === 'return' || name === 'enter') {
          const complaint = typeof validate === 'function' ? validate(value) : undefined
          if (complaint !== undefined) {
            process.stdout.write(`\n${red(complaint)}\n${render()}`)
            return
          }
          restore()
          process.stdout.write(`\n${green('✔')} ${message} ${'*'.repeat(Math.min(value.length, 24))}\n`)
          resolve(value)
          return
        }
        if (name === 'backspace' || name === 'delete') value = value.slice(0, -1)
        // 粘贴会一次性送来整串：只要不是控制键就整段收下
        else if (typeof str === 'string' && str.length > 0 && key?.ctrl !== true && key?.meta !== true && str >= ' ') value += str
        repaint()
      } catch (error) {
        restore()
        process.stdout.write('\n')
        reject(error)
      }
    }
    stdin.on('keypress', listener)
  })
}

/** 是/否确认；直接回车采用 `initial`。 */
export async function confirm({ message, initial = true }) {
  // 方向键选，不用手打 y/n：一是少一次「想一下我在问什么」，二是和 select 的操作一致。
  // （仍然接受 y / n 直选：肌肉记忆不该被破坏。）
  let cursor = initial ? 0 : 1
  const labels = ['是', '否']
  const render = () => {
    const choices = labels
      .map((label, index) => (index === cursor ? cyan(`❯ ${label}`) : dim(`  ${label}`)))
      .join('  ')
    return [
      `${cyan('?')} ${message}  ${choices}`,
      `  ${dim('←/→ 选择，回车确认（也可以直接按 y / n）')}`,
    ]
  }
  const value = await keyLoop({
    cleanupLines: clearLines,
    render,
    onKey: (str, key, finish) => {
      if (key?.name === 'left' || key?.name === 'up') { cursor = 0; return false }
      if (key?.name === 'right' || key?.name === 'down') { cursor = 1; return false }
      if (key?.name === 'tab') { cursor = cursor === 0 ? 1 : 0; return false }
      if (/^[yY]$/.test(str ?? '')) { finish(true); return true }
      if (/^[nN]$/.test(str ?? '')) { finish(false); return true }
      if (key?.name === 'return' || key?.name === 'enter') { finish(cursor === 0); return true }
      if (key?.name === 'escape') { finish(initial); return true }
      return false
    },
  })
  note(`${green('✔')} ${message} ${bold(value ? '是' : '否')}`)
  return value
}

/** 文本输入；`validate` 返回字符串表示不合法（作为提示重新问）。 */
export async function input({ message, initial = '', validate }) {
  note(`${cyan('?')} ${message}${initial === '' ? '' : dim(` (${initial})`)}`)
  const rl = readline.createInterface({ input: stdinOf(), output: process.stdout, terminal: true })
  for (;;) {
    const raw = String(await new Promise(resolve => rl.question(`${cyan('›')} `, resolve))).trim()
    const value = raw === '' ? initial : raw
    const problem = validate?.(value)
    if (problem === undefined) {
      rl.close()
      return value
    }
    note(`${yellow('!')} ${problem}`)
  }
}

/**
 * 等待指示器（ora 那个位置）。
 *
 * 只在静默期转：任何 `note` 之前都要先 `stop()`，否则两路输出会互相踩行。
 */
export function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let current = label
  let index = 0
  const paint = () => process.stdout.write(`\r${ESC}2K${cyan(frames[index++ % frames.length])} ${current}`)
  const timer = setInterval(paint, 80)
  paint()
  return {
    update(text) { current = text; paint() },
    stop(final) {
      clearInterval(timer)
      process.stdout.write(`\r${ESC}2K`)
      if (final !== undefined) note(final)
    },
  }
}
