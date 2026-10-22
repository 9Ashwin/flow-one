import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from '../src/atomic.mjs'
import { asBridgeError } from '../src/errors.mjs'
import { assertMode, POSIX_MODES } from './platform.mjs'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fo-atomic-'))
}

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

/**
 * 复现 Windows 上的「目标被占用」。
 *
 * 真机造不出来：POSIX 的 `rename(2)` 允许覆盖一个被别的进程打开着的文件，Windows 的
 * `MoveFileEx(…, MOVEFILE_REPLACE_EXISTING)` 才会报 EPERM。所以这里把平台说成 win32，
 * 并让 `renameSync` 按 `plan`（收到第几次尝试，返回错误或 undefined）失败。
 */
function withWindowsRename(plan, body) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const realRename = fs.renameSync
  let attempts = 0
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fs.renameSync = (...args) => {
    attempts += 1
    const failure = plan(attempts)
    if (failure !== undefined) throw failure
    realRename(...args)
  }
  try {
    return body(() => attempts)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    fs.renameSync = realRename
  }
}

test('正常路径：内容与权限位一次写对，不留临时文件', () => {
  const dir = scratch()
  const file = path.join(dir, 'settings.json')
  writeFileAtomic(file, '{"model":"a"}\n', 0o600)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"a"}\n')
  assertMode(file, 0o600)
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
})

test('Windows：rename 一直被占用（EPERM）时退让到原地覆盖，内容必须写进去', () => {
  const dir = scratch()
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{"model":"old"}')

  withWindowsRename(() => eperm(), attempts => {
    writeFileAtomic(file, '{"model":"new"}\n', 0o644)
    assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"new"}\n', '被占用不是「配置写不进去」的理由')
    assertMode(file, 0o644, '就地覆盖后要恢复成目标权限位')
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'], '临时文件必须清掉')
    assert.ok(attempts() > 1, '不能一次失败就放弃：占用通常几十毫秒内自己就放开了')
  })
})

test('Windows：占用只是一瞬（第一次 EPERM，第二次成功）→ 仍然走原子路径', () => {
  const dir = scratch()
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{"model":"old"}')

  withWindowsRename(n => (n === 1 ? eperm() : undefined), attempts => {
    writeFileAtomic(file, '{"model":"new"}\n', 0o644)
    assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"new"}\n')
    assert.equal(attempts(), 2, '一次短暂占用只该多花一次 rename')
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
  })
})

test('Windows：目标是只读文件 → 清掉只读位后照样写得进去', () => {
  const dir = scratch()
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{"model":"old"}')
  fs.chmodSync(file, 0o444)

  withWindowsRename(() => eperm(), () => {
    writeFileAtomic(file, '{"model":"new"}\n', 0o644)
    assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"new"}\n')
    assertMode(file, 0o644, '写回去之后不能还留着只读位')
  })
})

test('POSIX：rename 被拒**不退让**（那一定是真问题），抛类型化错误并保住原文件', { skip: !POSIX_MODES && 'POSIX 专属语义：Windows 上 rename 失败要退让' }, () => {
  const dir = scratch()
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{"model":"old"}')

  const realRename = fs.renameSync
  fs.renameSync = () => { throw eperm() }
  let thrown
  try {
    writeFileAtomic(file, '{"model":"new"}\n', 0o644)
  } catch (error) {
    thrown = error
  } finally {
    fs.renameSync = realRename
  }

  assert.ok(thrown !== undefined, 'mac/Linux 上写不进去就必须抛错，不能被 Windows 的退让掩盖')
  const typed = asBridgeError(thrown)
  assert.equal(typed?.subtype, 'io_failed', '命令边界的失败必须是契约错误，让脚本能分支')
  assert.match(typed === undefined ? '' : typed.hint, /占着|只读/, 'hint 要给恢复动作，而不是只说一句 EPERM')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"old"}', '原子写失败不能留下半截文件')
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], '临时文件要清掉')
})
