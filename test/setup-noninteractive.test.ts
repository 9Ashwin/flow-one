import test from 'node:test'
import assert from 'node:assert/strict'

import { asBridgeError } from '../src/errors.ts'
import { setupWizard } from '../src/wizard.ts'

/**
 * 非交互终端下的回归。
 *
 * 症状（2026-10-22 真机）：`fo setup --clients dsh --product intl --model …` 在没有 TTY
 * 的环境里照常打印第 1 步菜单，然后**退出码 0** 结束 —— 调用方（agent、CI、管道）
 * 以为配置成功，实际一个字节都没写。后来靠 `~/.dsh` 里没有 provider 才发现。
 *
 * 期望：没有 TTY 就直接报一个类型化错误，把「改用什么」写进 hint。
 */
test('setup：非交互终端不许静默成功，必须抛类型化错误', async () => {
  const { isInteractive } = await import('../src/prompt.ts')
  if (isInteractive()) {
    // 交互式终端里跑这条用例没有意义：跳过并说明原因，而不是假装通过。
    test.skip?.('当前进程有 TTY，跳过非交互断言')
    return
  }
  let thrown
  try {
    await setupWizard({ clients: [], service: false })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, '非交互终端里 setup 不能「打印菜单然后返回 0」')
  // 源码尚未给 BridgeError 补类型，这里只声明用例真正用到的两个字段。
  const typed = asBridgeError(thrown) as { category?: string; hint?: string } | undefined
  assert.equal(typed?.category, 'validation', '这是用户输入/环境不满足，不是内部错误')
  assert.match(typed === undefined ? '' : (typed.hint ?? ''), /flow-one client|flow-one`/, 'hint 要给可执行的替代做法')
})
