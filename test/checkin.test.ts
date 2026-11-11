import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkinDate, checkinState, runCheckin, setCheckinEnabled } from '../src/checkin.ts'

function fixture(t: { after: (fn: () => void) => void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-checkin-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  let clock = Date.parse('2026-11-11T04:00:00Z')
  const requests: string[] = []
  const credential = async () => ({ accessToken: 'test-only', account: { uid: 'test-user' } })
  const fetcher: typeof fetch = async url => {
    requests.push(String(url))
    return Response.json({
      code: 0,
      data: String(url).endsWith('status') ? { active: true, today_checked_in: false } : { credit: 100 },
    })
  }
  return {
    options: { home, now: () => clock, credential, fetcher },
    requests,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test('UTC+8 midnight changes the deduplication date regardless of local timezone', () => {
  assert.equal(checkinDate(Date.parse('2026-11-10T15:59:59Z')), '2026-11-10')
  assert.equal(checkinDate(Date.parse('2026-11-10T16:00:00Z')), '2026-11-11')
})

test('persisted success suppresses repeated runs and restart, then permits the next day', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  assert.equal((await runCheckin(f.options)).result, 'claimed')
  assert.equal(checkinState(f.options.home).successDate, '2026-11-11')
  await runCheckin({ ...f.options })
  assert.equal(f.requests.length, 2)
  f.advance(86_400_000)
  await runCheckin(f.options)
  assert.equal(f.requests.length, 4)
})

test('server already checked in suppresses reward request and persists success', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  let calls = 0
  const result = await runCheckin({
    ...f.options,
    fetcher: async () => {
      calls++
      return Response.json({ code: 0, data: { active: true, today_checked_in: true } })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.result, 'already_checked_in')
  assert.equal(result.successDate, '2026-11-11')
})

test('network failure never marks success and retry budget survives reload and enable', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  let calls = 0
  const options = {
    ...f.options,
    fetcher: async () => {
      calls++
      throw new TypeError('offline')
    },
  }
  for (let i = 0; i < 3; i++) {
    await assert.rejects(runCheckin(options), /Check-in request failed/)
    await runCheckin({ ...options })
    f.advance(15 * 60_000)
  }
  await setCheckinEnabled(true, f.options)
  await runCheckin(options)
  assert.equal(calls, 3)
  assert.equal(checkinState(f.options.home).successDate, '')
  f.advance(86_400_000)
  assert.equal((await runCheckin(f.options)).result, 'claimed')
})

test('inactive activity does not claim or masquerade as successful check-in', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  const s = await runCheckin({
    ...f.options,
    fetcher: async () => Response.json({ code: 0, data: { active: false, today_checked_in: false } }),
  })
  assert.equal(s.result, 'inactive')
  assert.equal(s.successDate, '')
  assert.equal(s.attempts, 3)
})

test('malformed status and failed claim do not persist successful state', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  await assert.rejects(runCheckin({ ...f.options, fetcher: async () => Response.json({ code: 0, data: {} }) }))
  f.advance(15 * 60_000)
  await assert.rejects(
    runCheckin({
      ...f.options,
      fetcher: async url => (String(url).endsWith('status') ? f.options.fetcher(url) : Response.json({ code: 0 })),
    }),
  )
  assert.equal(checkinState(f.options.home).successDate, '')
})

test('pause and a changed account prevent all provider calls', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  await setCheckinEnabled(false, f.options)
  await runCheckin(f.options)
  assert.equal(f.requests.length, 0)
  await setCheckinEnabled(true, f.options)
  await assert.rejects(
    runCheckin({ ...f.options, credential: async () => ({ accessToken: 'other', account: { uid: 'other' } }) }),
    /account changed/,
  )
  assert.equal(f.requests.length, 0)
})

test('concurrent runners cannot pass the OS lock and issue duplicate claims', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const running = runCheckin({
    ...f.options,
    credential: async () => {
      entered()
      await waiting
      return f.options.credential()
    },
  })
  await started
  try {
    await assert.rejects(runCheckin(f.options), /lock is busy/)
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../cli.ts', import.meta.url)), 'checkin', 'run', '--json'],
      {
        env: { ...process.env, BRIDGE_HOME: f.options.home, HOME: f.options.home, CLAUDE_CONFIG_DIR: f.options.home },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assert.equal(child.status, 4, child.stderr)
    assert.match(child.stderr, /Check-in lock is busy/)
  } finally {
    release()
  }
  await running
  assert.equal(f.requests.length, 2)
})

test('a fresh CLI process reads persisted success without credentials or network', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  await runCheckin(f.options)
  const state = checkinState(f.options.home)
  state.successDate = checkinDate()
  fs.writeFileSync(path.join(f.options.home, 'checkin.json'), JSON.stringify(state))
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.ts', import.meta.url)), 'checkin', 'run'], {
    env: { ...process.env, BRIDGE_HOME: f.options.home, HOME: f.options.home, CLAUDE_CONFIG_DIR: f.options.home },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout).successDate, checkinDate())
  assert.equal(JSON.parse(child.stdout).account, undefined)
})

test('midnight during status query defers claim until a new date is checked', async t => {
  const f = fixture(t)
  await setCheckinEnabled(true, f.options)
  await assert.rejects(
    runCheckin({
      ...f.options,
      fetcher: async url => {
        const r = await f.options.fetcher(url)
        f.advance(86_400_000)
        return r
      },
    }),
    /date changed/,
  )
  assert.equal(f.requests.length, 1)
  assert.equal(checkinState(f.options.home).successDate, '')
})
