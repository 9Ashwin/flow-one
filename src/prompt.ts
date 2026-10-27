// Terminal UI components (zero dependencies).
//
// The shape follows [zcf](https://github.com/UfoMiao/zcf): **banner → numbered sections
// → type the number**, instead of cramming a screenful of options into an arrow-key list.
// Menus are printed (not repainted by a TUI), so they stay legible in any terminal and
// through any `| tee` pipe; only list-style picking (the model list) uses the interactive
// arrow-key plus number selector.
//
// Only `node:readline` and ANSI escape sequences are used, no third-party libraries: one
// of this project's selling points is that `git clone` is enough to run `node cli.ts`.

import readline from 'node:readline'
import type { Key } from 'node:readline'
import process from 'node:process'

const ESC = '\x1b['

/** One ANSI helper: takes text, returns it wrapped in escape codes. */
export type StyleFn = (text: string) => string

export const style: Record<'bold' | 'dim' | 'cyan' | 'green' | 'yellow' | 'red' | 'gray', StyleFn> = {
  bold: text => `${ESC}1m${text}${ESC}22m`,
  dim: text => `${ESC}2m${text}${ESC}22m`,
  cyan: text => `${ESC}36m${text}${ESC}39m`,
  green: text => `${ESC}32m${text}${ESC}39m`,
  yellow: text => `${ESC}33m${text}${ESC}39m`,
  red: text => `${ESC}31m${text}${ESC}39m`,
  gray: text => `${ESC}90m${text}${ESC}39m`,
}

/** Color helpers are also exported individually: `import { green }` beats writing `style.green` everywhere. */
export const { bold, dim, cyan, green, yellow, red, gray } = style

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * stdin seam (**for tests only**).
 *
 * Test cases need to "pretend to be a TTY and feed keystrokes". The earlier approach
 * reassigned `process.stdin` directly, which corrupted node:test's own bookkeeping —
 * adding one such test to a file made that file report *fewer* tests overall, with
 * nothing unusual in the log. Swapping the stream here instead keeps the global untouched.
 */
/**
 * What the widgets need from stdin: a readable stream plus the raw-mode switch a
 * real TTY has. Tests inject a `PassThrough` with those two members grafted on.
 */
export type StdinSeam = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
}

let stdinOverride: StdinSeam | null = null
export function setStdinForTest(stream: StdinSeam | null): void {
  stdinOverride = stream
}
const stdinOf = (): StdinSeam => stdinOverride ?? process.stdin

function clearLines(count: number): void {
  if (count <= 0) return
  process.stdout.write(`${ESC}${count}A`)
  for (let i = 0; i < count; i++) process.stdout.write(`${ESC}2K\n`)
  process.stdout.write(`${ESC}${count}A`)
}

/** CJK characters and full-width punctuation take two columns; box drawing and alignment depend
 * on it, otherwise Chinese titles skew the frame. */
/** ANSI color codes must be stripped before measuring, or they count as visible
 * characters and skew the border. */
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g

export function displayWidth(text: unknown): number {
  let width = 0
  for (const char of String(text).replace(ANSI_PATTERN, '')) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char)
      ? 2
      : 1
  }
  return width
}

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

export const note = (text: string): void => {
  process.stdout.write(`${text}\n`)
}
export const blank = (): void => {
  process.stdout.write('\n')
}
export const rule = (width = 46): void => note(dim('─'.repeat(width)))
export const heading = (text: string): void => note(`\n${bold(text)}`)
export const success = (text: string): void => note(`${green('✔')} ${text}`)
export const warn = (text: string): void => note(`${yellow('!')} ${text}`)
export const fail = (text: string): void => note(`${red('✘')} ${text}`)
export const info = (text: string): void => note(`${cyan('›')} ${text}`)

/** zcf-style section heading: `──────── Maintenance ────────`. */
export function section(title: string): void {
  note(`  ${dim(`──────── ${title} ────────`)}`)
}

/** Draw a box with content aligned by display width (the two-column CJK cost is already accounted for). */
export function box(lines: string[], { color = cyan }: { color?: StyleFn } = {}): void {
  // Inner width = longest line + one space on each side; the body is padded to
  // (width - 1) because that leading space is already part of the inner width.
  const width = Math.max(...lines.map(line => displayWidth(line)), 0) + 2
  note(color(`  ╭${'─'.repeat(width)}╮`))
  for (const line of lines) note(`${color('  │')} ${pad(line, width - 1)}${color('│')}`)
  note(color(`  ╰${'─'.repeat(width)}╯`))
}

/** Project banner: name + version + a one-line description, in the same slot as zcf's opening block. */
export function banner(subtitle: string, version = ''): void {
  blank()
  box([`flow-one${version === '' ? '' : `  ${version}`}`, subtitle])
}

/** A printable keypress as node:readline reports it (`str` is the decoded text). */
export type KeyEvent = Key

/** Completes a keypress loop; the value becomes `keyLoop`'s result. */
export type FinishFn<T> = (value: T) => void

/** Return `true` from `onKey` when the loop is done and must not repaint. */
export type OnKeyFn<T> = (str: string | undefined, key: KeyEvent, finish: FinishFn<T>) => boolean

interface KeyLoopSpec<T> {
  render: () => string[]
  onKey: OnKeyFn<T>
  cleanupLines?: (count: number) => void
}

/** Run a keypress loop; rendering is delegated to `render()`. Cleanup must always restore the cursor and raw mode. */
function keyLoop<T>({ render, onKey, cleanupLines }: KeyLoopSpec<T>): Promise<T> {
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
    const finish = (value: T) => {
      restore()
      cleanupLines?.(drawn)
      resolve(value)
    }
    const listener = (str: string | undefined, key: Key | undefined) => {
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

/** One printed menu entry: `key` is what the user types, `label` is what they read. */
export interface MenuItem {
  key: string
  label: string
  hint?: string
  /** Renders the key in red (destructive actions). */
  danger?: boolean
}

export interface MenuGroup {
  title?: string
  items: MenuItem[]
}

export interface MenuSpec {
  title: string
  groups: MenuGroup[]
}

/**
 * Printed numbered menu (the zcf main-menu shape).
 *
 * Options are **printed** and then selected by typing a number, rather than moved
 * through inside a TUI: the whole screen stays visible, and pasting the output into a
 * chat or a log keeps its context.
 */
export async function menu({ title, groups }: MenuSpec): Promise<string> {
  note(`\n${bold(title)}`)
  const keys: string[] = []
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
  const normalized = (value: string) => value.toLowerCase()
  const allowed = new Set(keys.map(normalized))
  const answer = await input({
    message: '请输入编号',
    validate: value =>
      allowed.has(normalized(value)) ? undefined : `请输入 ${groups.flatMap(g => g.items.map(i => i.key)).join(' / ')}`,
  })
  return answer.trim().toUpperCase()
}

/**
 * One row of a list picker. `separator: true` marks a group heading (unnumbered,
 * unselectable); `disabled: true` marks an entry that exists but cannot be chosen.
 */
export interface SelectOption<T = string> {
  label: string
  value: T
  hint?: string
  disabled?: boolean
  separator?: boolean
}

export interface SelectSpec<T = string> {
  message: string
  options: Array<SelectOption<T>>
  initial?: number
  filterable?: boolean
  windowSize?: number
}

/**
 * List picking: arrow keys or a number.
 *
 * Number rule (works even for long lists): keep accumulating digits as long as another
 * digit could still form a valid index, otherwise select immediately — with 5 options
 * pressing `1` selects outright; with 13 options pressing `1` moves the cursor and `3`
 * then completes 13, or press `1` followed by Enter to pick the first.
 */
/** Searchable text of an option: label, value and hint all count, so users need not guess which field to search. */
const searchTextOf = (option: SelectOption<unknown>): string =>
  `${option.label ?? ''} ${option.value ?? ''} ${option.hint ?? ''}`.toLowerCase()

/**
 * List selection.
 *
 * With `filterable: true`, **typing filters directly** and results update as you type
 * (no need to pick a "filter" entry first): printable characters extend the query,
 * backspace deletes one, Esc clears it, ↑↓ moves within the results, Enter confirms.
 * A model list of a hundred-plus entries is unusable without this — which is why in this
 * mode `j`/`k` are ordinary characters, not navigation keys.
 *
 * When results exceed `windowSize`, only the slice around the cursor is drawn and the
 * total count is shown: however long the list gets, it never scrolls the screen away.
 * The default (`filterable: false`) keeps the original shape: list everything, pick by number.
 *
 * An option with `separator: true` is only a group heading: unnumbered, unselectable,
 * skipped by the cursor; any filtering keystroke drops them — group headings inside
 * search results only mislead.
 */
export async function select<T = string>({
  message,
  options,
  initial = 0,
  filterable = false,
  windowSize = 12,
}: SelectSpec<T>): Promise<T> {
  if (options.length === 0) throw new Error('select requires at least one option')
  // The cursor must not land on disabled entries (the "not logged in yet" kind, which
  // only error again if chosen) or on group headings: landing on a heading makes the
  // first arrow-key press look like a no-op.
  const firstEnabled = (list: Array<SelectOption<T>>, from = 0): number => {
    if (list.length === 0) return 0
    let index = Math.min(Math.max(from, 0), list.length - 1)
    for (let step = 0; step < list.length; step++) {
      if (list[index]?.disabled !== true && list[index]?.separator !== true) break
      index = (index + 1) % list.length
    }
    return index
  }
  const isReal = (option: SelectOption<T> | undefined) => option !== undefined && option.separator !== true
  let query = ''
  let visible: Array<SelectOption<T>> = options
  let cursor = firstEnabled(options, initial)
  let typed = ''
  const numberWidth = String(options.length).length
  const done = (option: SelectOption<T>, finish: FinishFn<T>): boolean => {
    finish(option.value)
    note(`${green('✔')} ${message} ${bold(option.label)}`)
    return true
  }
  const realCount = (list: Array<SelectOption<T>>) => list.filter(isReal).length
  const applyQuery = () => {
    const needle = query.trim().toLowerCase()
    // Drop group headings while filtering: re-inserting "free models / other models" into results only misleads
    visible =
      needle === '' ? options : options.filter(option => isReal(option) && searchTextOf(option).includes(needle))
    cursor = firstEnabled(visible)
  }
  /** Skip group headings when moving (they are not selectable in filterable mode). */
  const step = (delta: number) => {
    if (visible.length === 0) return
    let next = cursor
    for (let i = 0; i < visible.length; i++) {
      next = (next + delta + visible.length) % visible.length
      if (isReal(visible[next]) && visible[next]?.disabled !== true) {
        cursor = next
        return
      }
    }
  }
  const hint = filterable ? '直接敲字筛选，↑↓ 选择，回车确认' : '↑↓ 选择，或直接按编号，回车确认'
  note(`${cyan('?')} ${message}  ${dim(hint)}`)
  return await keyLoop<T>({
    cleanupLines: clearLines,
    render: () => {
      const lines: string[] = []
      if (filterable) {
        lines.push(
          query === ''
            ? `  ${dim(`直接敲字筛选 · 共 ${realCount(options)} 项`)}`
            : `  ${cyan('筛选')} ${bold(query)}  ${dim(`${realCount(visible)}/${realCount(options)} 项`)}`,
        )
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
      if (name === 'up') {
        typed = ''
        step(-1)
      } else if (name === 'down') {
        typed = ''
        step(1)
      } else if (filterable && (name === 'backspace' || name === 'delete')) {
        query = query.slice(0, -1)
        applyQuery()
      } else if (filterable && name === 'escape') {
        query = ''
        applyQuery()
      } else if (name === 'return' || name === 'enter') {
        const option = visible[cursor]
        if (isReal(option) && option?.disabled !== true) return done(option!, finish)
      } else if (filterable) {
        // Every printable character goes into the query: letters, digits, dots and dashes
        // in model IDs are all searchable
        if (typeof str === 'string' && str.length > 0 && key.ctrl !== true && key.meta !== true && str >= ' ') {
          query += str
          applyQuery()
        }
      } else if (name === 'left' || str === 'k') {
        typed = ''
        step(-1)
      } else if (name === 'right' || str === 'j') {
        typed = ''
        step(1)
      } else if (name === 'backspace') typed = typed.slice(0, -1)
      else if (typeof str === 'string' && /^\d$/.test(str)) {
        const next = typed + str
        const index = Number(next) - 1
        if (index >= 0 && index < options.length && next.length <= numberWidth) {
          typed = next
          cursor = index
          if (Number(next) * 10 > options.length) {
            const option = options[index]
            if (option.disabled !== true && option.separator !== true) return done(option, finish)
            typed = ''
          }
        }
      }
      return false
    },
  })
}

/**
 * Secret input: typed characters echo as `*`.
 *
 * Secrets end up in the credential file and must not linger in the terminal scrollback
 * where someone could glance at them — hence a dedicated widget rather than bending
 * `input()` into shape.
 */
export interface PasswordSpec {
  message: string
  /** Returns a complaint when the value is unacceptable; the question repeats. */
  validate?: (value: string) => string | undefined
}

export async function password({ message, validate }: PasswordSpec): Promise<string> {
  const stdin = stdinOf()
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()
  let value = ''
  const render = () =>
    `${cyan('?')} ${message} ${value === '' ? dim('粘贴后回车') : '*'.repeat(Math.min(value.length, 24))}`
  process.stdout.write(render())
  return await new Promise<string>((resolve, reject) => {
    const restore = () => {
      stdin.removeListener('keypress', listener)
      if (!wasRaw) stdin.setRawMode?.(false)
      stdin.pause()
    }
    const repaint = () => {
      process.stdout.write(`\r${ESC}2K${render()}`)
    }
    const listener = (str: string | undefined, key: Key | undefined) => {
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
        // Paste arrives as one whole string: accept it wholesale as long as it is not a control key
        else if (typeof str === 'string' && str.length > 0 && key?.ctrl !== true && key?.meta !== true && str >= ' ')
          value += str
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

export interface ConfirmSpec {
  message: string
  initial?: boolean
}

/** Yes/no confirmation; pressing Enter adopts `initial`. */
export async function confirm({ message, initial = true }: ConfirmSpec): Promise<boolean> {
  // Arrow keys instead of typed y/n: one less "wait, what is it asking" moment, and the
  // controls match `select`. (Typing y / n still works: muscle memory should not break.)
  let cursor = initial ? 0 : 1
  const labels = ['是', '否']
  const render = () => {
    const choices = labels.map((label, index) => (index === cursor ? cyan(`❯ ${label}`) : dim(`  ${label}`))).join('  ')
    return [`${cyan('?')} ${message}  ${choices}`, `  ${dim('←/→ 选择，回车确认（也可以直接按 y / n）')}`]
  }
  const value = await keyLoop<boolean>({
    cleanupLines: clearLines,
    render,
    onKey: (str, key, finish) => {
      if (key?.name === 'left' || key?.name === 'up') {
        cursor = 0
        return false
      }
      if (key?.name === 'right' || key?.name === 'down') {
        cursor = 1
        return false
      }
      if (key?.name === 'tab') {
        cursor = cursor === 0 ? 1 : 0
        return false
      }
      if (/^[yY]$/.test(str ?? '')) {
        finish(true)
        return true
      }
      if (/^[nN]$/.test(str ?? '')) {
        finish(false)
        return true
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        finish(cursor === 0)
        return true
      }
      if (key?.name === 'escape') {
        finish(initial)
        return true
      }
      return false
    },
  })
  note(`${green('✔')} ${message} ${bold(value ? '是' : '否')}`)
  return value
}

export interface InputSpec {
  message: string
  initial?: string
  /** Returns a complaint when the value is unacceptable; the question repeats. */
  validate?: (value: string) => string | undefined
}

/** Text input; `validate` returning a string means invalid (the string is shown and the question repeats). */
export async function input({ message, initial = '', validate }: InputSpec): Promise<string> {
  note(`${cyan('?')} ${message}${initial === '' ? '' : dim(` (${initial})`)}`)
  const rl = readline.createInterface({ input: stdinOf(), output: process.stdout, terminal: true })
  for (;;) {
    const raw = String(await new Promise<string>(resolve => rl.question(`${cyan('›')} `, resolve))).trim()
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
 * Wait indicator (the slot ora occupies).
 *
 * It only spins while quiet: call `stop()` before any `note`, otherwise the two output
 * paths trample each other's lines.
 */
export interface Spinner {
  update(text: string): void
  /** Erase the spinner line; `final` is printed as a normal note afterwards. */
  stop(final?: string): void
}

export function spinner(label: string): Spinner {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let current = label
  let index = 0
  const paint = () => process.stdout.write(`\r${ESC}2K${cyan(frames[index++ % frames.length])} ${current}`)
  const timer = setInterval(paint, 80)
  paint()
  return {
    update(text: string) {
      current = text
      paint()
    },
    stop(final?: string) {
      clearInterval(timer)
      process.stdout.write(`\r${ESC}2K`)
      if (final !== undefined) note(final)
    },
  }
}
