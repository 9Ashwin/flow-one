import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 终端界面组件的用例单独放一个文件。
 *
 * ⚠️ 它们会临时接管 `process.stdin`（假装是 TTY 并手动投喂按键）。放在别的用例
 * 同一个文件里会干扰 node:test 的结果记账 —— 实测：往 install.test.mjs 里加一个
 * 这样的用例，整个文件的用例计数反而从 25 掉到 24，日志里看不出任何异常。
 * 所以界面用例与安装器用例分文件。
 */

test('交互组件：方向键选择、回车确认，非 TTY 时明确拒绝', async () => {
  const { isInteractive, select } = await import('../src/prompt.mjs')
  assert.equal(isInteractive(), false, '测试进程没有 TTY')

  // 造一个假 TTY：只要让 setRawMode/resume/pause 存在，按键就能被手动投喂。
  const stdin = process.stdin
  const original = { isTTY: stdin.isTTY, setRawMode: stdin.setRawMode, resume: stdin.resume, pause: stdin.pause }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  try {
    const pending = select({
      message: '选哪个？',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }],
    })
    stdin.emit('keypress', '', { name: 'down' })
    stdin.emit('keypress', '', { name: 'down' })
    stdin.emit('keypress', '', { name: 'up' })
    stdin.emit('keypress', '', { name: 'return' })
    assert.equal(await pending, 'b', '两次下、一次上应落在 B')
  } finally {
    Object.assign(stdin, original)
  }
})

test('菜单支持数字直选：短清单立即选中，长清单两位数', async () => {
  const { select } = await import('../src/prompt.mjs')
  const stdin = process.stdin
  const original = { isTTY: stdin.isTTY, setRawMode: stdin.setRawMode, resume: stdin.resume, pause: stdin.pause }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.resume = () => {}
  stdin.pause = () => {}
  try {
    // 5 个选项：按 3 立即选中第 3 个
    const short = select({ message: 'q', options: ['a', 'b', 'c', 'd', 'e'].map(v => ({ label: v, value: v })) })
    stdin.emit('keypress', '3', { name: '3' })
    assert.equal(await short, 'c')

    // 12 个选项：按 1 只移动光标，再按 2 才是第 12 个
    const long = select({ message: 'q', options: Array.from({ length: 12 }, (_, i) => ({ label: `m${i + 1}`, value: i + 1 })) })
    stdin.emit('keypress', '1', { name: '1' })
    stdin.emit('keypress', '2', { name: '2' })
    assert.equal(await long, 12)

    // 长清单里按一个数字后回车，选的是那一位
    const long2 = select({ message: 'q', options: Array.from({ length: 12 }, (_, i) => ({ label: `m${i + 1}`, value: i + 1 })) })
    stdin.emit('keypress', '1', { name: '1' })
    stdin.emit('keypress', '', { name: 'return' })
    assert.equal(await long2, 1)
  } finally {
    Object.assign(stdin, original)
  }
})

test('编号菜单：大小写都认，非法编号会重问', async () => {
  const { PassThrough } = await import('node:stream')
  const { menu } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
  try {
    const pending = menu({
      title: '请选择：',
      groups: [{ items: [{ key: '1', label: '甲' }, { key: 'Q', label: '退出', danger: true }] }],
    })
    fake.write('x\n')   // 非法编号 → 必须重问而不是当成 Q
    await new Promise(resolve => setTimeout(resolve, 30))
    fake.write('q\n')   // 小写也要认
    assert.equal(await pending, 'Q')
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'stdin', descriptor)
  }
})
