// Atomic persistence: a temp file in the same directory, then rename over the target.
//
// This is a separate module because **Windows rename is not POSIX rename**, and that
// can only have one implementation: both `settings.json` (install.ts) and
// `credentials.json` (auth.ts) go through it, and two copies would inevitably end
// up with only one of them fixed.
//
// The semantic difference: POSIX `rename(2)` atomically replaces even a target another
// process has open; on Windows `fs.renameSync` goes through
// `MoveFileEx(…, MOVEFILE_REPLACE_EXISTING)`, and once the target is in use (an
// antivirus scan, an editor, a running claude) it reports `ERROR_ACCESS_DENIED` →
// Node throws `EPERM`/`EBUSY` (the same defect is on record for npm's
// write-file-atomic: https://github.com/npm/write-file-atomic/issues/227).
//
// Hit on real hardware (2026-10-19, Windows): step 4 of the wizard, "write and run
// persistently", crashed with EPERM, not a single byte of `settings.json` was
// written, and the user believed the setup had succeeded.
//
// So on Windows there are two fallback levels:
//
//   ① Retry rename after a few milliseconds — the antivirus/indexer holding it
//      usually lets go within tens of milliseconds, and a successful retry is still
//      atomic;
//   ② Clear the target's read-only bit and **overwrite in place**: give up atomicity
//      in exchange for "the content really got written". A bad write is not fatal:
//      callers always back up first (`settings.json` has `.bak-*`, and the ledger and
//      credentials are rebuildable by nature).
//
// POSIX does **not** take these two fallbacks: an EPERM/EACCES there is always a real
// problem (unwritable directory, read-only mount), and papering over it only turns
// "the config was not written" into a harder-to-diagnose symptom.
import fs from 'node:fs';
import path from 'node:path';
import { SUBTYPES, internalError } from "./errors.js";
/** Error codes on Windows that mean "target in use / read-only" and are worth falling back on. */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Rename retry backoff sequence (ms). At worst 130ms extra, which nobody notices. */
const RETRY_BACKOFF_MS = [10, 30, 90];
/**
 * Synchronous wait.
 *
 * `setTimeout` is not used because the install path is entirely synchronous (write
 * config → write ledger → install service), so the retry must burn the time in place.
 * `Atomics.wait` has no side effects on the main thread — it just parks on a
 * SharedArrayBuffer nobody references.
 */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Write a file atomically.
 *
 * @param file target file
 * @param text full contents (formatting is the caller's job)
 * @param mode target permission bits (on Windows only the read-only bit matters)
 */
export function writeFileAtomic(file, text, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { mode });
    try {
        replace(temporary, file, text, mode);
    }
    catch (error) {
        // On failure do not leave a .tmp in someone's directory; failing to delete it
        // must not mask the real error either.
        try {
            fs.rmSync(temporary, { force: true });
        }
        catch {
            /* still in use; leave it for the next overwrite */
        }
        throw error;
    }
}
/** Node's fs errors carry `code`; anything else is narrowed to just a message. */
const codeOf = (error) => typeof error.code === 'string' ? error.code : undefined;
const messageOf = (error) => error instanceof Error ? error.message : String(error.message);
/** Rename over the target, with retry and in-place overwrite fallbacks on Windows. */
function replace(temporary, file, text, mode) {
    for (let attempt = 0;; attempt++) {
        try {
            fs.renameSync(temporary, file);
            return;
        }
        catch (error) {
            const code = codeOf(error);
            if (process.platform !== 'win32' || code === undefined || !RETRYABLE.has(code)) {
                throw ioFailure(file, code ?? messageOf(error), error);
            }
            if (attempt < RETRY_BACKOFF_MS.length) {
                sleepSync(RETRY_BACKOFF_MS[attempt]);
                continue;
            }
            try {
                overwriteInPlace(temporary, file, text, mode);
                return;
            }
            catch (fallbackError) {
                throw ioFailure(file, `rename ${code} then in-place overwrite both failed: ${codeOf(fallbackError) ?? messageOf(fallbackError)}`, fallbackError);
            }
        }
    }
}
/**
 * In-place overwrite: **atomicity is abandoned**, only "the content got written" is guaranteed.
 *
 * The read-only bit is cleared first: Windows `chmod` is just that bit, and a read-only
 * target cannot be written by either rename or overwrite; on POSIX this step also
 * rescues a file left at 0444. The target permission bits are restored afterwards —
 * `writeFileSync`'s `mode` only applies when the file is **created**, not when an
 * existing file is overwritten.
 */
function overwriteInPlace(temporary, file, text, mode) {
    try {
        fs.chmodSync(file, 0o666);
    }
    catch {
        /* file does not exist yet / cannot be cleared: let the write below report it */
    }
    fs.writeFileSync(file, text);
    fs.chmodSync(file, mode);
    try {
        fs.rmSync(temporary, { force: true });
    }
    catch {
        /* still in use: the content is already written, which is enough */
    }
}
/**
 * How a failed write is reported.
 *
 * It used to be a bare `internal error: EPERM: operation not permitted` — the user
 * could not tell whether this was a permission problem, a file in use, or a bug in
 * this program, and so had no way to act (that is exactly where it stalled on real
 * hardware).
 */
function ioFailure(file, detail, cause) {
    return internalError(SUBTYPES.IO_FAILED, `cannot write ${file} (${detail})`)
        .withHint('Check that no other program holds this file open (antivirus, editors and a running claude all count), ' +
        'and that it is not read-only; if that does not help, re-run as administrator (Windows) or with sudo (macOS/Linux).')
        .withCause(cause);
}
