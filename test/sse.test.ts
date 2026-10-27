import test from 'node:test'
import assert from 'node:assert/strict'
import { readSse } from '../src/sse.ts'

function stream(
  text: string,
  { open = false, cancel = () => {} }: { open?: boolean; cancel?: (reason: unknown) => void } = {},
) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      // 每个字节独立，覆盖 UTF-8 与 CRLF 跨网络分片。
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      if (!open) controller.close()
    },
    cancel,
  })
}
const collect = async (body: ReadableStream<Uint8Array>) => {
  const rows: unknown[] = []
  for await (const row of readSse(body)) rows.push(row)
  return rows
}

for (const newline of ['\n', '\r\n', '\r']) {
  test(`SSE 多行 data 按事件拼接，支持 ${JSON.stringify(newline)} 与 UTF-8 分片`, async () => {
    const text = [
      '\uFEFF: ping',
      'event: message',
      'data: {"text":',
      'data: "你好"}',
      '',
      'data: broken',
      '',
      'data: {"ok":true}',
      '',
      '',
    ].join(newline)
    assert.deepEqual(await collect(stream(text)), [{ text: '你好' }, { ok: true }])
  })
}
test('SSE DONE 立即取消仍打开的上游，不消费后续帧', async () => {
  let cancelled = false
  const body = stream('data: {"ok":true}\n\ndata: [DONE]\n\ndata: {"late":true}\n\n', {
    open: true,
    cancel: () => {
      cancelled = true
    },
  })
  // 旧实现会读取 late 后阻塞；提前取两次即可确定失败而不留下挂起读取。
  const iterator = readSse(body)
  assert.deepEqual((await iterator.next()).value, { ok: true })
  assert.equal((await iterator.next()).done, true)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})
test('SSE 消费者提前退出释放 reader，读流异常原样传递', async () => {
  let cancelled = false
  const body = stream('data: {}\n\n', {
    open: true,
    cancel: () => {
      cancelled = true
    },
  })
  for await (const row of readSse(body)) {
    assert.deepEqual(row, {})
    break
  }
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
  const failed = new ReadableStream({
    start(controller) {
      controller.error(new Error('broken socket'))
    },
  })
  await assert.rejects(collect(failed), /broken socket/)
  assert.equal(failed.locked, false)
})
test('SSE EOF 不派发没有空行结束的不完整事件', async () => {
  assert.deepEqual(await collect(stream('data: {"partial":true}\n')), [])
})

test('截断的上游流不能当成完整回答，但 finish_reason 后 EOF 仍兼容', async () => {
  const strict = async (input: string) => {
    for await (const _ of readSse(stream(input), true)) {
      /* consume */
    }
  }
  await assert.rejects(strict('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), /before completion/)
  await strict('data: {"choices":[{"finish_reason":"stop"}]}\n\n')
  await strict('data: [DONE]\n\n')
  await assert.rejects(strict('data: invalid\n\n'), /invalid SSE JSON/)
})
