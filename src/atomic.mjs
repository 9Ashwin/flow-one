/**
 * 原子落盘：同目录临时文件 + rename 覆盖目标。
 *
 * 单独成模块是因为 **Windows 的 rename 不是 POSIX 的 rename**，而这件事只能有一份实现：
 * `settings.json`（install.mjs）与 `credentials.json`（auth.mjs）都要走它，抄两份的结果
 * 必然是只修好一份。
 *
 * 语义差别：POSIX 的 `rename(2)` 即使目标被别的进程打开着也照样原子替换；Windows 上
 * `fs.renameSync` 走 `MoveFileEx(…, MOVEFILE_REPLACE_EXISTING)`，目标一旦被占用（正在扫的
 * 杀毒软件、编辑器、正在跑的 claude）就报 `ERROR_ACCESS_DENIED` → Node 抛 `EPERM`/`EBUSY`
 * （同类缺陷在 npm 的 write-file-atomic 上也有记录：
 * https://github.com/npm/write-file-atomic/issues/227）。
 *
 * 真机撞到过（2026-10-19，Windows）：向导第 4 步「写入并常驻」直接 EPERM 崩掉，
 * `settings.json` 一个字都没写进去，而用户以为自己配好了。
 *
 * 所以 Windows 上退让两级：
 *
 *   ① 等几毫秒重试 rename —— 占用它的杀软/索引器通常几十毫秒内自己就放开了，
 *      重试成功时仍然是原子的；
 *   ② 清掉目标的只读位后**原地覆盖**：牺牲原子性，换「内容真的写进去了」。写坏也不至于
 *      没救：调用方写前都有备份（settings.json 有 `.bak-*`，账本与凭据本身就是可重建的）。
 *
 * POSIX **不做**这两级退让：那边的 EPERM/EACCES 一定是真问题（目录不可写、只读挂载），
 * 用退让掩盖它只会把「配置没写成功」变成一个更难查的现象。
 *
 * @module src/atomic.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { SUBTYPES, internalError } from './errors.mjs'

/** Windows 上属于「目标被占用 / 只读」这一类、值得退让的错误码。 */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** rename 重试的等待序列（毫秒）。最坏多等 130ms，人感知不到。 */
const RETRY_BACKOFF_MS = [10, 30, 90]

/**
 * 同步等待。
 *
 * 不用 `setTimeout`：安装路径整条是同步的（写配置 → 写账本 → 装服务），重试必须把时间
 * 原地等掉。主线程上 `Atomics.wait` 没有副作用 —— 拿一个没人引用的 SharedArrayBuffer
 * 当停车场而已。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 原子写文件。
 *
 * @param {string} file 目标文件
 * @param {string} text 完整内容（格式化由调用方负责）
 * @param {number} mode 目标权限位（Windows 上只影响只读位）
 */
export function writeFileAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { mode })
  try {
    replace(temporary, file, text, mode)
  } catch (error) {
    // 失败就别把 .tmp 留在人家目录里；删不掉也不能盖住真正的错
    try { fs.rmSync(temporary, { force: true }) } catch { /* 占用中，留给下次覆盖 */ }
    throw error
  }
}

/** rename 覆盖，Windows 上带重试与原地覆盖两级退让。 */
function replace(temporary, file, text, mode) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, file)
      return
    } catch (error) {
      if (process.platform !== 'win32' || !RETRYABLE.has(error.code)) {
        throw ioFailure(file, error.code ?? error.message, error)
      }
      if (attempt < RETRY_BACKOFF_MS.length) {
        sleepSync(RETRY_BACKOFF_MS[attempt])
        continue
      }
      try {
        overwriteInPlace(temporary, file, text, mode)
        return
      } catch (fallbackError) {
        throw ioFailure(
          file,
          `rename ${error.code} 后原地覆盖也失败：${fallbackError.code ?? fallbackError.message}`,
          fallbackError,
        )
      }
    }
  }
}

/**
 * 原地覆盖：**放弃原子性**，只保证内容写进去。
 *
 * 先清只读位：Windows 的 `chmod` 就是切只读位，而只读的目标「rename」与「覆盖」都写不进；
 * POSIX 上这一步让被设成 0444 的文件也能救回来。写完再恢复成目标权限位 —— `writeFileSync`
 * 的 `mode` 只在**新建**文件时生效，覆盖已有文件时不起作用。
 */
function overwriteInPlace(temporary, file, text, mode) {
  try { fs.chmodSync(file, 0o666) } catch { /* 文件还不存在 / 清不掉：让下面的写入自己报错 */ }
  fs.writeFileSync(file, text)
  fs.chmodSync(file, mode)
  try { fs.rmSync(temporary, { force: true }) } catch { /* 正被占用：内容已经写进去了就够了 */ }
}

/**
 * 写不进去时的说法。
 *
 * 原来的表现是一句 `内部错误：EPERM: operation not permitted` —— 用户看不出这到底是
 * 「没权限」「文件被占用」还是「本程序的 bug」，也就无从下手（真机上就是这么卡住的）。
 */
function ioFailure(file, detail, cause) {
  return internalError(SUBTYPES.IO_FAILED, `写不进去：${file}（${detail}）`)
    .withHint('确认没有别的程序占着这个文件（杀毒软件、编辑器、正在跑的 claude 都算），'
      + '也确认它不是只读的；都不行就用管理员（Windows）或 sudo（macOS/Linux）重跑一次。')
    .withCause(cause)
}
