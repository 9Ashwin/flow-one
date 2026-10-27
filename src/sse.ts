// Reading OpenAI-shaped SSE and normalising upstream failures.
//
// This is a separate module to break a circular dependency: both `upstreams.ts`
// (the gateway upstream) and `opencode.ts` (the free-tier upstream) need it, and
// the former imports the latter.

import type { ChatFailure } from './types.ts'

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  requireCompletion = false,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let skipLf = false
  let finished = false
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
          let chunk: unknown
          try {
            chunk = JSON.parse(payload)
          } catch {
            if (requireCompletion) throw new Error('upstream sent invalid SSE JSON')
            continue
          }
          if (chunk !== null && typeof chunk === 'object' && 'choices' in chunk && Array.isArray(chunk.choices)) {
            finished ||= chunk.choices.some(
              (choice: unknown) =>
                choice !== null &&
                typeof choice === 'object' &&
                'finish_reason' in choice &&
                typeof choice.finish_reason === 'string',
            )
          }
          yield chunk
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    if (requireCompletion && (!finished || data.length > 0 || buffer.trim() !== '')) {
      throw new Error('upstream SSE ended before completion')
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* keep the original read error */
    }
    reader.releaseLock()
  }
}

/** The upstream error body as it is actually shaped by each vendor. */
interface FailurePayload {
  error?: { message?: unknown; type?: unknown } | unknown
  msg?: unknown
  message?: unknown
}

/** A non-2xx upstream response → `{ok:false, status, message}`, keeping its own reason where possible. */
export async function failureOf(response: Response): Promise<ChatFailure> {
  let message = `upstream returned ${response.status}`
  try {
    const raw = await response.text()
    if (raw.trim() !== '') {
      try {
        // Narrowed immediately: this is external JSON from four different upstreams.
        const payload = JSON.parse(raw) as FailurePayload | null
        const error = payload?.error as { message?: unknown; type?: unknown } | undefined
        // OpenCode's error is `{error:{type,message}}`; other upstreams mostly use `{error:{message}}`
        const detail = error?.message ?? error?.type ?? payload?.msg ?? payload?.message ?? payload?.error
        message = typeof detail === 'string' && detail !== '' ? detail : JSON.stringify(detail ?? payload).slice(0, 500)
      } catch {
        message = raw.trim().slice(0, 500)
      }
    }
  } catch {
    /* no body to read; the status code is information enough */
  }
  return { ok: false, status: response.status, message }
}
