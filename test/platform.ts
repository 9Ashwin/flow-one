import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 平台差异的测试助手。
 *
 * 这个仓库的一等目标是 macOS 与 Linux，但 Windows 上的 `chmod` 只切只读位：
 * `fs.statSync(file).mode & 0o777` 拿到的是 0o666（438），永远不会等于 0o600。
 * 用例里直接断言权限位在 Windows 上必然红，而它想验证的东西（凭据不对外可读）
 * 在那边由 ACL 而不是 mode 表达 —— 所以断言本身要按平台分开，不是把断言删掉。
 */

/** 权限位断言只在 POSIX 上成立。 */
export const POSIX_MODES = process.platform !== 'win32'

/**
 * 断言文件权限位。
 *
 * POSIX：必须精确等于 `mode`。
 * Windows：只断言「可写位跟着走」—— 0o600/0o644 的差别在那边不存在，能验的只有
 * 只读位有没有被正确恢复。
 */
export function assertMode(file: fs.PathLike, mode: number, message?: string) {
  const actual = fs.statSync(file).mode & 0o777
  if (POSIX_MODES) {
    if (message === undefined) assert.equal(actual, mode)
    else assert.equal(actual, mode, message)
    return
  }
  const writable = (actual & 0o200) !== 0
  const expectedWritable = (mode & 0o200) !== 0
  if (message === undefined) assert.equal(writable, expectedWritable)
  else assert.equal(writable, expectedWritable, `${message}（Windows 只校验可写位）`)
}

/** 临时目录一律走 `os.tmpdir()`：Windows 上没有 `/tmp`。 */
export function scratchDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
