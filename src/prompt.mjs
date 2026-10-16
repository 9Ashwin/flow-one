/**
 * 零依赖交互组件。
 *
 * 只用 `node:readline` 的按键事件 + ANSI 转义序列，不引第三方提示库：这个项目的
 * 卖点之一是 `git clone` 完直接 `node cli.mjs` 就能跑，不该为了一个箭头菜单
 * 让人先 `npm install`。
 *
 * 非 TTY（管道、CI、`node cli.mjs < /dev/null`）下 `isInteractive()` 为假，
 * 调用方应改走命令行参数，而不是在这里假装有人按键。
 *
 * @module src/prompt.mjs
 */

import readline from 'node:readline'
import process from 'node:process'

const ESC = '\x1b['
const dim = text => `${ESC}2m${text}${ESC}22m`
const cyan = text => `${ESC}36m${text}${ESC}39m`
const green = text => `${ESC}32m${text}${ESC}39m`
const yellow = text => `${ESC}33m${text}${ESC}39m`

export const style = { dim, cyan, green, yellow, bold: text => `${ESC}1m${text}${ESC}22m` }

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function clearLines(count) {
  if (count <= 0) return
  process.stdout.write(`${ESC}${count}A`)
  for (let i = 0; i < count; i++) process.stdout.write(`${ESC}2K\n`)
  process.stdout.write(`${ESC}${count}A`)
}

/**
 * 跑一个按键循环，把渲染交给 `render(state)`。
 *
 * 收尾一定要恢复光标与 raw mode：漏掉任何一处，用户回到 shell 后终端会一直
 * 不显示光标、或者每敲一个键都冒出 `^[[A`。
 */
function keyLoop({ render, onKey, cleanupLines }) {
  const stdin = process.stdin
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
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
    const finish = value => {
      stdin.removeListener('keypress', listener)
      process.stdout.write(`${ESC}?25h`)
      if (!wasRaw) stdin.setRawMode(false)
      stdin.pause()
      cleanupLines?.(drawn)
      resolve(value)
    }
    const listener = (str, key) => {
      if (key?.ctrl && key.name === 'c') {
        stdin.removeListener('keypress', listener)
        process.stdout.write(`${ESC}?25h\n`)
        if (!wasRaw) stdin.setRawMode(false)
        process.exit(130)
      }
      try {
        const done = onKey(str, key ?? {}, finish)
        if (done === true) return
        draw()
      } catch (error) {
        stdin.removeListener('keypress', listener)
        process.stdout.write(`${ESC}?25h\n`)
        if (!wasRaw) stdin.setRawMode(false)
        reject(error)
      }
    }
    stdin.on('keypress', listener)
    draw()
  })
}

/**
 * 单选菜单。
 *
 * @param {{message: string, options: Array<{label: string, hint?: string, value: any, disabled?: boolean}>, initial?: number}} spec
 */
export async function select({ message, options, initial = 0 }) {
  if (options.length === 0) throw new Error('select 需要至少一个选项')
  let cursor = Math.min(Math.max(initial, 0), options.length - 1)
  // 光标不落在禁用项上：菜单里禁用项通常是「还没登录」这类，选下去只会再报一次错
  while (options[cursor]?.disabled === true) cursor = (cursor + 1) % options.length
  process.stdout.write(`${cyan('?')} ${message}\n`)
  const answer = await keyLoop({
    cleanupLines: clearLines,
    render: () => options.map((option, index) => {
      const active = index === cursor
      const pointer = active ? cyan('❯') : ' '
      const label = option.disabled === true ? dim(option.label) : active ? option.label : dim(option.label)
      const hint = option.hint === undefined || option.hint === '' ? '' : `  ${dim(option.hint)}`
      return `${pointer} ${label}${hint}`
    }),
    onKey: (str, key, finish) => {
      const name = key.name
      if (name === 'up' || str === 'k') cursor = (cursor - 1 + options.length) % options.length
      else if (name === 'down' || str === 'j') cursor = (cursor + 1) % options.length
      else if (name === 'return' || name === 'enter') {
        const option = options[cursor]
        if (option.disabled !== true) {
          finish(option.value)
          process.stdout.write(`${green('✓')} ${message} ${style.bold(option.label)}\n`)
          return true
        }
      } else if (/^[1-9]$/.test(str) && Number(str) <= options.length) {
        const option = options[Number(str) - 1]
        if (option.disabled !== true) {
          finish(option.value)
          process.stdout.write(`${green('✓')} ${message} ${style.bold(option.label)}\n`)
          return true
        }
      }
      return false
    },
  })
  return answer
}

/** 是/否确认；默认值用 `initial` 指定，直接回车即采用。 */
export async function confirm({ message, initial = true }) {
  const hint = initial ? 'Y/n' : 'y/N'
  process.stdout.write(`${cyan('?')} ${message} ${dim(`(${hint})`)} `)
  const answer = await new Promise(resolve => {
    const stdin = process.stdin
    readline.emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    const listener = (str, key) => {
      if (key?.ctrl && key.name === 'c') {
        stdin.removeListener('keypress', listener)
        if (!wasRaw) stdin.setRawMode(false)
        process.exit(130)
      }
      if (key?.name === 'return' || key?.name === 'enter') return done(String(initial))
      if (/^[yYnN]$/.test(str)) return done(/^[yY]$/.test(str))
      if (key?.name === 'escape') return done(String(initial))
    }
    const done = value => {
      stdin.removeListener('keypress', listener)
      if (!wasRaw) stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write(`${value === 'true' ? 'y' : 'n'}\n`)
      resolve(value === 'true')
    }
    stdin.on('keypress', listener)
  })
  return answer
}

/** 文本输入；`validate` 返回字符串表示不合法（当作错误提示显示）。 */
export async function input({ message, initial = '', validate }) {
  process.stdout.write(`${cyan('?')} ${message}${initial === '' ? '' : dim(` (${initial})`)}\n`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const ask = () => new Promise(resolve => rl.question(`${cyan('›')} `, resolve))
  for (;;) {
    const raw = String(await ask()).trim()
    const value = raw === '' ? initial : raw
    const problem = validate?.(value)
    if (problem === undefined) {
      rl.close()
      return value
    }
    process.stdout.write(`${yellow('!')} ${problem}\n`)
  }
}

export function note(text) {
  process.stdout.write(`${text}\n`)
}

export function heading(text) {
  process.stdout.write(`\n${style.bold(text)}\n`)
}

export function success(text) {
  process.stdout.write(`${green('✓')} ${text}\n`)
}

export function warn(text) {
  process.stdout.write(`${yellow('!')} ${text}\n`)
}

export function fail(text) {
  process.stdout.write(`${ESC}31m✗${ESC}39m ${text}\n`)
}

/** 一屏宽度的分割线，纯装饰。 */
export function rule() {
  const width = Math.min(process.stdout.columns ?? 60, 64)
  process.stdout.write(`${dim('─'.repeat(width))}\n`)
}
