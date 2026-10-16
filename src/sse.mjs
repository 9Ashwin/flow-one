/**
 * OpenAI 形状 SSE 的读取与失败归一。
 *
 * 单独成模块是为了打断循环依赖：`upstreams.mjs`（网关上游）与 `opencode.mjs`
 * （免费档上游）都要用它，而前者要 import 后者。
 *
 * @module src/sse.mjs
 */

/** 逐行解析 SSE；`[DONE]` 与注释行跳过，坏帧丢掉而不是打断整轮。 */
export async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          yield JSON.parse(payload)
        } catch { /* 坏帧丢掉比打断整轮更划算 */ }
      }
    }
  } finally {
    reader.cancel?.().catch(() => {})
  }
}

/** 上游的非 2xx 响应 → `{ok:false, status, message}`，尽量保留它原本的理由。 */
export async function failureOf(response) {
  let message = `上游返回 ${response.status}`
  try {
    const raw = await response.text()
    if (raw.trim() !== '') {
      try {
        const payload = JSON.parse(raw)
        // OpenCode 的错误是 `{error:{type,message}}`；别家多是 `{error:{message}}`
        const detail = payload?.error?.message ?? payload?.error?.type ?? payload?.msg ?? payload?.message ?? payload?.error
        message = typeof detail === 'string' && detail !== '' ? detail : JSON.stringify(detail ?? payload).slice(0, 500)
      } catch {
        message = raw.trim().slice(0, 500)
      }
    }
  } catch { /* 读不到正文，状态码本身就是信息 */ }
  return { ok: false, status: response.status, message }
}
