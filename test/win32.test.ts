import test from 'node:test'
import assert from 'node:assert/strict'

import { browserCommand } from '../src/auth.ts'
import { SUBTYPES } from '../src/errors.ts'

/**
 * Windows 上的回归：登录链接必须整条交给浏览器。
 *
 * 症状（2026-10-22 真机）：`fo login intl` 打印的链接带 `platform=…&state=…&version=…`，
 * 自动打开浏览器后停在缺 `state` 的页面。根因是走 `cmd /c start`，cmd 把 `&` 当成
 * 命令分隔符，URL 在第一个 `&` 处被截断。
 *
 * 这条用例盯的就是「命令不是 cmd」这件事本身：只要有人把它改回 `cmd /c start`，
 * 或者给 URL 丢了引号，这里就红。
 */
test('Windows：打开浏览器不能经过 cmd，否则 & 会把登录链接截断', () => {
  const url = 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=abc&version=5.5.2&loginSessionId=def'
  const { command, args } = browserCommand(url)

  if (process.platform === 'win32') {
    assert.notEqual(command, 'cmd', 'cmd 会按 & 切命令，链接必然被截断')
    assert.ok(args.includes(url), 'URL 必须整条作为一个参数传出去')
  } else if (process.platform === 'darwin') {
    assert.equal(command, 'open')
    assert.deepEqual(args, [url])
  } else {
    assert.equal(command, 'xdg-open')
    assert.deepEqual(args, [url])
  }
})

test('SUBTYPES 里 service_unsupported 属于 config 闭集，能用于「平台不支持常驻」', () => {
  // 这条断言盯着错误契约：`--service` 装不上时要报一个已声明的 subtype，
  // 而不是裸 throw（裸抛会让调用方只能靠文本分支）。
  assert.equal(SUBTYPES.SERVICE_UNSUPPORTED, 'service_unsupported')
})
