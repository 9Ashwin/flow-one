import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { chat, failureDetail } from '../src/buddy.mjs'
import { classifyTencentFailure } from '../src/doctor.mjs'
import { CN } from '../src/products.mjs'

/**
 * 今天真机上抓到的两条失败报文（2026-10-21，intl/deepseek-v4.1-flash）。
 *
 * 只保留判据字段：`msg` 是一句没有信息量的 `request illegal`，真正能指导人的是
 * `displayMsg` / `displayTips` 和 `code`。
 */
const BLOCKED_BODY = JSON.stringify({
  code: 11128,
  msg: 'request illegal',
  displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重新发送' },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client.',
    zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
  },
})

/** 额度耗尽：形状与风控**不同**（code 嵌在 error.data 里）。 */
const LIMITED_BODY = JSON.stringify({
  error: { data: { code: 14018, msg: 'Credits exhausted. Please visit the link below to purchase add-on packs' } },
})

test('上游失败理由：11128 的渠道校验文案不能被丢成一句 request illegal', () => {
  const detail = failureDetail(BLOCKED_BODY)
  assert.match(detail, /11128/, '上游数字码要带上：脚本与 doctor 据此分支')
  assert.match(detail, /请求被拦截/, '中文文案比英文 msg 更直接')
  assert.match(detail, /渠道校验/, 'displayTips 才是「为什么被拒」')
})

test('上游失败理由：额度耗尽的 code 嵌在 error.data 里，也要认出来', () => {
  const detail = failureDetail(LIMITED_BODY)
  assert.match(detail, /14018/)
  assert.match(detail, /Credits exhausted/)
})

test('风控与额度必须分开判：判错了会把「等额度」引成「翻规则」', () => {
  const blocked = classifyTencentFailure(failureDetail(BLOCKED_BODY))
  assert.deepEqual(blocked, { blocked: true, limited: false })

  const limited = classifyTencentFailure(failureDetail(LIMITED_BODY))
  assert.deepEqual(limited, { blocked: false, limited: true })
})

test('chat 失败时把上游码与中文提示一起带出来（客户端只看到 request illegal 等于没信息）', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(BLOCKED_BODY)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const endpoint = `http://127.0.0.1:${server.address().port}`

  // 注入一份「不会过期」的凭据：ensureCredential 只读文件，不会真去登录
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-buddy-'))
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ intl: { accessToken: 'at-test', expiresAt: Date.now() + 86_400_000 } }))
  const product = { ...CN, id: 'intl', endpoint, apiDomain: '127.0.0.1', label: '替身产品' }

  const result = await chat(product, { messages: [{ role: 'user', content: 'ping' }] }, { model: 'deepseek-v4.1-flash', file })
  assert.equal(result.ok, false)
  assert.match(result.message, /11128/)
  assert.match(result.message, /渠道校验/)
  // 这条断言就是这次真机误诊的回归点：doctor 曾经把它判成「与门禁无关」
  assert.equal(classifyTencentFailure(result.message).blocked, true)
})

test('国际版会话身份头：缺了就被渠道校验拦（2026-10-21 起的 11128）', async t => {
  const seen = []
  // 复刻上游的真实行为：缺任一「会话身份头」→ 400 + 11128；三个都在 → 正常出流
  const server = http.createServer(async (req, res) => {
    seen.push(req.headers)
    const complete = req.headers['x-conversation-id'] !== undefined
      && req.headers['x-conversation-request-id'] !== undefined
      && req.headers['x-conversation-message-id'] !== undefined
    if (!complete) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(BLOCKED_BODY)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const endpoint = `http://127.0.0.1:${server.address().port}`

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-buddy-'))
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ intl: { accessToken: 'at-test', expiresAt: Date.now() + 86_400_000 } }))
  const product = { ...CN, id: 'intl', endpoint, apiDomain: '127.0.0.1', label: '替身产品' }
  const body = { messages: [{ role: 'user', content: 'ping' }] }

  const first = await chat(product, body, { model: 'deepseek-v4.1-flash', file })
  assert.equal(first.ok, true, '三个会话头都在就该过')
  await first.response.text()
  const second = await chat(product, body, { model: 'deepseek-v4.1-flash', file })
  assert.equal(second.ok, true)
  await second.response.text()

  // 会话 id 按进程固定，请求/消息 id 每轮新生成（与官方客户端同形）
  assert.equal(seen[0]['x-conversation-id'], seen[1]['x-conversation-id'])
  assert.notEqual(seen[0]['x-conversation-request-id'], seen[1]['x-conversation-request-id'])
  assert.notEqual(seen[0]['x-conversation-message-id'], seen[1]['x-conversation-message-id'])
})
