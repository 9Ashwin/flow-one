// An opt-in live benchmark: exercise a stable system prefix and an append-only
// conversation against an already running bridge. It never reads local credentials.

const [baseUrl, model] = process.argv.slice(2)
if (!baseUrl || !model) {
  process.stderr.write('Usage: node scripts/cache-benchmark.ts <bridge-base-url> <model>\n')
  process.exit(2)
}

const system =
  'You are a concise technical assistant.\n' +
  Array.from(
    { length: 220 },
    (_, index) =>
      `Document line ${index}: This code module has clear names, predictable behavior and isolated tests.\n`,
  ).join('')
const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []

for (let turn = 1; turn <= 4; turn++) {
  messages.push({ role: 'user', content: `Turn ${turn}: answer with a short greeting.` })
  const started = performance.now()
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.FO_CACHE_BENCH_API_KEY || 'benchmark',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, system, messages, max_tokens: 64, stream: false }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    process.stderr.write(`Benchmark turn ${turn} failed with HTTP ${response.status}.\n`)
    process.exitCode = 1
    break
  }
  const data = (await response.json()) as { content?: unknown; usage?: Record<string, unknown> }
  if (!Array.isArray(data.content)) {
    process.stderr.write(`Benchmark turn ${turn} returned no message content.\n`)
    process.exitCode = 1
    break
  }
  const usage = data.usage ?? {}
  process.stdout.write(
    `${JSON.stringify({ turn, model, total_ms: Math.round(performance.now() - started), input_tokens: usage.input_tokens ?? null, cache_read_input_tokens: usage.cache_read_input_tokens ?? null, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null })}\n`,
  )
  messages.push({ role: 'assistant', content: data.content })
}
