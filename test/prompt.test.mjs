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

test('列表挑选：方向键与编号都能选（短清单按数字立即选中，长清单两位数）', async () => {
  const { PassThrough } = await import('node:stream')
  const { select, setStdinForTest } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  fake.setRawMode = () => {}   // 真 TTY 才有；测试流补一个
  setStdinForTest(fake)
  const key = (str, name) => fake.emit('keypress', str, { name })
  try {
    // 方向键：两次下、一次上 → B
    const arrows = select({ message: 'q', options: ['A', 'B', 'C'].map(v => ({ label: v, value: v })) })
    key('', 'down'); key('', 'down'); key('', 'up'); key('', 'return')
    assert.equal(await arrows, 'B')

    // 5 个选项：按 5 立即选中第 5 个
    const short = select({ message: 'q', options: ['a', 'b', 'c', 'd', 'e'].map(v => ({ label: v, value: v })) })
    key('5', '5')
    assert.equal(await short, 'e')

    // 12 个选项：按 1 只移动光标，再按 2 得到第 12 个
    const long = select({ message: 'q', options: Array.from({ length: 12 }, (_, i) => ({ label: `m${i + 1}`, value: i + 1 })) })
    key('1', '1'); key('2', '2')
    assert.equal(await long, 12)

    // 12 个选项：按 1 后回车选第 1 个
    const long2 = select({ message: 'q', options: Array.from({ length: 12 }, (_, i) => ({ label: `m${i + 1}`, value: i + 1 })) })
    key('1', '1'); key('', 'return')
    assert.equal(await long2, 1)
  } finally {
    setStdinForTest(null)
  }
})

test('编号菜单：大小写都认，非法编号会重问', async () => {
  const { PassThrough } = await import('node:stream')
  const { menu, setStdinForTest } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  fake.setRawMode = () => {}   // 真 TTY 才有；测试流补一个
  setStdinForTest(fake)
  try {
    const pending = menu({
      title: '请选择：',
      groups: [{ items: [{ key: '1', label: '甲' }, { key: 'Q', label: '退出', danger: true }] }],
    })
    const feed = async line => { fake.write(`${line}\n`); await new Promise(resolve => setTimeout(resolve, 40)) }
    await feed('x')   // 非法编号 → 必须重问，而不是当成 Q
    await feed('q')   // 小写也要认
    assert.equal(await pending, 'Q')
  } finally {
    setStdinForTest(null)
  }
})

test('主菜单闭环：选 3 看状态 → 回车返回 → Q 退出', async () => {
  const { PassThrough } = await import('node:stream')
  const { mainMenu } = await import('../src/wizard.mjs')
  const { setStdinForTest } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  fake.setRawMode = () => {}   // 真 TTY 才有；测试流补一个
  setStdinForTest(fake)
  try {
    const pending = mainMenu()
    const feed = async (line, wait = 80) => { fake.write(`${line}\n`); await new Promise(resolve => setTimeout(resolve, wait)) }
    await feed('3')   // 查看状态（没有服务在跑也算正常）
    await feed('')    // 回车返回菜单
    await feed('q')   // 退出
    assert.equal(await pending, 0)
  } finally {
    setStdinForTest(null)
  }
})

test('列表筛选：边打边筛、退格删字、Esc 清空', async () => {
  const { PassThrough } = await import('node:stream')
  const { select, setStdinForTest } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  fake.setRawMode = () => {}
  setStdinForTest(fake)
  const key = (str, name) => fake.emit('keypress', str, { name })
  const options = [
    { label: 'cn/deepseek-v4.1-flash', value: 'cn' },
    { label: 'oc/deepseek-v4.1-flash-free', value: 'oc' },
    { label: 'intl/glm-5.3', value: 'glm' },
    { label: 'oc/big-pickle', value: 'pickle' },
  ]
  try {
    // 敲 `glm` 立刻只剩一条匹配，回车就选中它（不用先选「筛选」再输入）
    const filtered = select({ message: 'q', options, filterable: true })
    for (const ch of 'glm') key(ch, ch)
    key('', 'return')
    assert.equal(await filtered, 'glm')

    // 敲错 → 退格删掉 → 回到全量，回车取第一条
    const erased = select({ message: 'q', options, filterable: true })
    for (const ch of 'zzz') key(ch, ch)
    for (let i = 0; i < 3; i++) key('', 'backspace')
    key('', 'return')
    assert.equal(await erased, 'cn')

    // Esc 清空查询串
    const escaped = select({ message: 'q', options, filterable: true })
    key('p', 'p')
    key('', 'escape')
    key('', 'down')
    key('', 'return')
    assert.equal(await escaped, 'oc')
  } finally {
    setStdinForTest(null)
  }
})

test('列表筛选：上百条里照样能筛到窗口外的那一条', async () => {
  const { PassThrough } = await import('node:stream')
  const { select, setStdinForTest } = await import('../src/prompt.mjs')
  const fake = new PassThrough()
  fake.isTTY = true
  fake.setRawMode = () => {}
  setStdinForTest(fake)
  try {
    // 143 个模型那种规模：目标在很后面，靠打字筛到它
    const options = Array.from({ length: 143 }, (_, i) => ({ label: `oc/model-${i + 1}`, value: i + 1 }))
    const pending = select({ message: 'q', options, filterable: true })
    for (const ch of 'model-137') fake.emit('keypress', ch, { name: ch })
    fake.emit('keypress', '', { name: 'return' })
    assert.equal(await pending, 137)
  } finally {
    setStdinForTest(null)
  }
})
