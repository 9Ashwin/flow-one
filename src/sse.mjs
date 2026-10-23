/**
 * OpenAI 形状 SSE 的读取与失败归一。
 *
 * 单独成模块是为了打断循环依赖：`upstreams.mjs`（网关上游）与 `opencode.mjs`
 * （免费档上游）都要用它，而前者要 import 后者。
 *
 * @module src/sse.mjs
 */

/** 按空行切 SSE 事件；data 多行拼接，DONE 立即结束并释放上游连接。 */
export async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  let skipLf = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (skipLf && buffer !== '') {
        if (buffer.startsWith('\n')) buffer = buffer.slice(1)
        skipLf = false
      }
      let at
      while ((at = buffer.search(/[\r\n]/)) >= 0) {
        const line = buffer.slice(0, at)
        const cr = buffer[at] === '\r'
        buffer = buffer.slice(at + 1)
        if (cr) {
          if (buffer.startsWith('\n')) buffer = buffer.slice(1)
          else if (buffer === '') skipLf = true
        }
        if (line === '') {
          const payload = data.join('\n')
          data = []
          if (payload.trim() === '[DONE]') return
          if (payload === '') continue
          let chunk
          try { chunk = JSON.parse(payload) } catch { continue }
          yield chunk
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    // SSE 只有空行才派发事件，EOF 的未完成事件不能冒充完整回答。
  } finally {
    try { await reader.cancel() } catch { /* 保留原来的读流错误 */ }
    reader.releaseLock()
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
