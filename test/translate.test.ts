import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicMessage,
  createOutcome,
  createStreamTranslator,
  estimateInputTokens,
  foldChunk,
  toOpenAiRequest,
} from '../src/anthropic.ts'

/**
 * 源码这一轮只做了改名，导出还没有类型标注。用例在调用点按实际形状窄化一次：
 * `toOpenAiRequest` 要么给 `body` 要么给 `error`，两处断言各取其一。
 */
type OpenAiBody = {
  model: string
  messages: any[]
  tools: any[]
  tool_choice?: unknown
  max_tokens?: number
  temperature?: number
  stop?: string[]
  reasoning_effort?: string
  stream_options?: unknown
}

type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type AnthropicMessage = { content: any[]; stop_reason: string; usage: AnthropicUsage }

const openAiRequest = toOpenAiRequest as unknown as (
  request: any,
  options?: Record<string, unknown>,
) => { body: OpenAiBody; error: string }

const anthropicMessageOf = anthropicMessage as unknown as (
  outcome: any,
  options: { model: string; id: string; inputTokens?: number; showThinking?: boolean },
) => AnthropicMessage

const outcomeOf = createOutcome as unknown as () => any

test('上游拒答文本在流式和非流式响应中都不能丢失', () => {
  const chunks = [
    { choices: [{ delta: { refusal: 'Cannot do that.' } }] },
    { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
  ]
  const outcome = createOutcome()
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg', write: frame => frames.push(frame) })
  for (const chunk of chunks) {
    foldChunk(outcome, chunk)
    stream.push(chunk)
  }
  stream.end()
  assert.match(JSON.stringify(anthropicMessage(outcome, { model: 'm', id: 'msg' }).content), /Cannot do that/)
  assert.match(frames.join(''), /Cannot do that/)
  assert.match(frames.join(''), /"stop_reason":"refusal"/)
})

test('无效或非对象工具参数不能伪装成空对象成功结束', () => {
  for (const args of ['{"x":', '[]', 'null', '42']) {
    const chunk = {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'Read', arguments: args } }] },
          finish_reason: 'tool_calls',
        },
      ],
    }
    const outcome = createOutcome()
    foldChunk(outcome, chunk)
    assert.throws(() => anthropicMessage(outcome, { model: 'm', id: 'msg' }), /tool arguments/)
    const frames: string[] = []
    const stream = createStreamTranslator({ model: 'm', id: 'msg', write: frame => frames.push(frame) })
    stream.push(chunk)
    stream.end()
    assert.match(frames.join(''), /event: error/)
    assert.doesNotMatch(frames.join(''), /event: message_delta/)
  }
})

test('无索引的单工具分片必须合并，无法归属的并行分片必须报错', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg', write: frame => frames.push(frame) })
  const outcome = createOutcome()
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ id: 'call', function: { name: 'Read', arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] },
  ]
  for (const chunk of chunks) {
    foldChunk(outcome, chunk)
    assert.equal(stream.push(chunk), true)
  }
  stream.end()
  assert.equal(frames.filter(frame => frame.includes('"type":"tool_use"')).length, 1)
  assert.deepEqual(anthropicMessage(outcome, { model: 'm', id: 'msg' }).content[0], {
    type: 'tool_use',
    id: 'call',
    name: 'Read',
    input: { x: 1 },
  })
  const ambiguous = createStreamTranslator({ model: 'm', id: 'msg', write: () => {} })
  ambiguous.push({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'A' } },
            { index: 1, id: 'b', function: { name: 'B' } },
          ],
        },
      },
    ],
  })
  assert.equal(ambiguous.push({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] } }] }), false)
  assert.match(ambiguous.failure ?? '', /parallel call/)
})

test('Anthropic 请求 → OpenAI 报文：system、块、工具、工具结果', () => {
  const { body, error } = openAiRequest(
    {
      system: [{ type: 'text', text: '你是助手' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看这个' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '忽略我' },
            { type: 'text', text: '我来读' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' },
            { type: 'text', text: '继续' },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: '读文件',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
      stop_sequences: ['STOP'],
    },
    { model: 'cn/deepseek-v4.1-flash' },
  )

  assert.equal(error, undefined)
  assert.equal(body.model, 'cn/deepseek-v4.1-flash')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, '你是助手')
  // 图片与文本同轮
  const user = body.messages[1]
  assert.equal(user.role, 'user')
  assert.ok(Array.isArray(user.content))
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,AAAA')
  // thinking 被丢弃，tool_use 变成 tool_calls
  const assistant = body.messages[2]
  assert.equal(assistant.content, '我来读')
  assert.equal(assistant.tool_calls[0].id, 'toolu_1')
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { file_path: '/tmp/a' })
  // 工具结果先落地，紧随其后才是同轮文本
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.messages[3].tool_call_id, 'toolu_1')
  assert.equal(body.messages[3].content, 'hello')
  assert.equal(body.messages[4].role, 'user')
  assert.equal(body.messages[4].content, '继续')
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'Read')
  assert.equal(body.max_tokens, 1024)
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop, ['STOP'])
})

test('tool_choice:none 时连工具一起摘掉（上游不接受这个组合）', () => {
  const { body } = openAiRequest(
    {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'none' },
    },
    { model: 'm' },
  )
  assert.equal(body.tools, undefined)
  assert.equal(body.tool_choice, 'none')
})

test('thinking 预算映射到档位，max_tokens 会上限截断', () => {
  const effortOf = (budget: number) =>
    openAiRequest(
      { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: budget } },
      { model: 'm' },
    ).body.reasoning_effort
  const big = openAiRequest(
    { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 20000 } },
    { model: 'm' },
  )
  assert.equal(big.body.reasoning_effort, 'high')
  const small = openAiRequest(
    { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 1024 } },
    { model: 'm' },
  )
  assert.equal(small.body.reasoning_effort, 'low')
  // 档位必须和客户端的预算表一一对应（DSH：minimal 1024 / low 2048 / medium 8192 / high 16384）
  // 以前 ≥8192 就算 high，DSH 选 low/medium 会被整体升一档（2026-10-22 真机对齐）
  assert.equal(effortOf(1024), 'low', 'DSH minimal')
  assert.equal(effortOf(2048), 'low', 'DSH low 不能变成 medium')
  assert.equal(effortOf(8192), 'medium', 'DSH medium 不能变成 high')
  assert.equal(effortOf(16384), 'high', 'DSH high')
  assert.equal(effortOf(4096), 'medium', 'Claude Code 常见的 4096 预算')
  const capped = openAiRequest(
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 },
    { model: 'm', maxTokensCap: 32000 },
  )
  assert.equal(capped.body.max_tokens, 32000)
})

test('缺 messages / 非对象请求都给出可读的 400 理由', () => {
  assert.match(openAiRequest({ messages: [] }, { model: 'm' }).error, /messages/)
  assert.match(openAiRequest(null, { model: 'm' }).error, /JSON object/)
})

test('Claude Code 在 messages 中发送 system 时必须保留角色并应用渠道改写', () => {
  const request = {
    messages: [
      { role: 'system', content: 'source' },
      { role: 'user', content: 'hi' },
    ],
  }
  assert.deepEqual(toOpenAiRequest(request).body?.messages?.[0], { role: 'system', content: 'source' })
  assert.deepEqual(toOpenAiRequest(request, { rewriteSystem: text => `${text}!` }).body?.messages?.[0], {
    role: 'system',
    content: 'source!',
  })
})

test('结构化输出、推理档位和禁止并行调用不能在转换时丢失', () => {
  const { body } = toOpenAiRequest({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
  })
  assert.equal(body?.reasoning_effort, 'high')
  assert.equal(body?.parallel_tool_calls, false)
  assert.deepEqual(body?.response_format, {
    type: 'json_schema',
    json_schema: { name: 'messages_response', strict: true, schema: { type: 'object' } },
  })
  assert.match(
    toOpenAiRequest({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }).error ?? '',
    /unsupported content/,
  )
  assert.match(
    toOpenAiRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_result', tool_use_id: 'x', content: 'result' },
          ],
        },
      ],
    }).error ?? '',
    /reordering/,
  )
})

test('工具参数分片中插入文本不能产生相互重叠的内容块', () => {
  const events: any[] = []
  const stream = createStreamTranslator({
    model: 'm',
    id: 'msg_x',
    write: frame => events.push(JSON.parse(frame.split('\ndata: ')[1])),
  })
  stream.push({
    choices: [
      {
        delta: { content: 'text', tool_calls: [{ index: 0, id: 'call', function: { name: 'Read', arguments: '{' } }] },
      },
    ],
  })
  stream.push({ choices: [{ delta: { content: 'more', tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] })
  stream.end()
  const toolStop = events.findIndex(e => e.type === 'content_block_stop' && e.index === 0)
  const textStart = events.findIndex(e => e.type === 'content_block_start' && e.content_block.type === 'text')
  assert.ok(toolStop >= 0 && textStart > toolStop)
  assert.equal(events.find(e => e.delta?.type === 'text_delta').delta.text, 'textmore')
})

test('流式：文本 → text_delta，收尾发 message_delta + message_stop', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_1', write: (frame: string) => frames.push(frame) })
  stream.push({ choices: [{ delta: { content: '你' } }] })
  stream.push({ choices: [{ delta: { content: '好' } }] })
  stream.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })
  stream.end()
  const events = frames.map(frame => frame.split('\n')[0].replace('event: ', ''))
  assert.deepEqual(events, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  assert.match(frames[0], /"input_tokens":0/)
  assert.match(frames.join(''), /"stop_reason":"end_turn"/)
  assert.match(frames.at(-2) as string, /"output_tokens":2/)
})

test('流式：工具调用开成 tool_use 块，参数走 input_json_delta，stop_reason=tool_use', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_2', write: (frame: string) => frames.push(frame) })
  stream.push({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"file' } }] } }],
  })
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"/a"}' } }] } }] })
  stream.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  stream.end()
  const joined = frames.join('')
  assert.match(joined, /"type":"tool_use","id":"call_a","name":"Read","input":\{\}/)
  assert.match(joined, /"type":"input_json_delta","partial_json":"\{\\"file"/)
  assert.match(joined, /"stop_reason":"tool_use"/)
})

test('流式：参数先于名字到达时先攒着，等名字到齐再开场', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_3', write: (frame: string) => frames.push(frame) })
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] })
  assert.doesNotMatch(frames.join(''), /tool_use/, '名字没到之前不该开场')
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b', function: { name: 'Glob' } }] } }] })
  stream.end()
  const joined = frames.join('')
  assert.match(joined, /"name":"Glob"/)
  const delta = frames.find(frame => frame.includes('input_json_delta')) as string
  assert.equal(JSON.parse(delta.split('data: ')[1]).delta.partial_json, '{"a":1}')
})

test('流内错误帧翻成 error 事件，且不再发 message_delta', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_4', write: (frame: string) => frames.push(frame) })
  assert.equal(stream.push({ error: { message: '内容被安全策略拦截' } }), false)
  stream.fail(stream.failure)
  const joined = frames.join('')
  assert.match(joined, /event: error/)
  assert.match(joined, /内容被安全策略拦截/)
  assert.doesNotMatch(joined, /message_delta/)
  assert.match(joined, /event: message_stop/)
})

test('非流式归并：usage 与 tool_calls 都落到 Anthropic 消息体', () => {
  const outcome = outcomeOf()
  foldChunk(outcome, {
    choices: [
      {
        message: { content: '读到了', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"p":1}' } }] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  })
  const message = anthropicMessageOf(outcome, { model: 'cn/x', id: 'msg_5', inputTokens: 3 })
  assert.equal(message.stop_reason, 'tool_use')
  assert.equal(message.usage.input_tokens, 11)
  assert.equal(message.usage.output_tokens, 5)
  assert.deepEqual(message.content[1], { type: 'tool_use', id: 'c1', name: 'Read', input: { p: 1 } })
})

test('本地 token 估算：随内容增长，且不为空请求返回 0', () => {
  const small = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] })
  const big = estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
  assert.ok(small > 0)
  assert.ok(big > small + 900)
})

test('腾讯内容指纹：只在两个片段同现时改写，且改写后仍保留身份句', async () => {
  const { isTencentModel, rewriteTencentFingerprints, systemRewriterFor } = await import('../src/fingerprint.ts')
  const blocked = "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive CLI tool."
  const rewritten = rewriteTencentFingerprints(blocked)
  assert.match(rewritten, /an official CLI for Claude/)
  assert.doesNotMatch(rewritten, /Anthropic's official CLI/)
  assert.match(rewritten, /You are Claude Code,/)
  // 只有一半时不改：那两句实测本来就不被拦，改了只是白白让前缀缓存失效
  assert.equal(rewriteTencentFingerprints('You are Claude Code.'), 'You are Claude Code.')
  assert.equal(
    rewriteTencentFingerprints("You are Anthropic's official CLI for Claude."),
    "You are Anthropic's official CLI for Claude.",
  )
  assert.equal(rewriteTencentFingerprints('You are terse.'), 'You are terse.')
  // 只对腾讯系模型生效
  assert.equal(isTencentModel('cn/x') && isTencentModel('workbuddy/x') && !isTencentModel('deepseek-chat'), true)
  assert.equal(systemRewriterFor('deepseek-chat'), undefined)
  assert.equal(systemRewriterFor('cn/x', false), undefined)
})

test('改写器接在请求翻译上：system 被改写，用户内容原样', () => {
  const { body } = openAiRequest(
    {
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: "Anthropic's official CLI for Claude" }],
    },
    { model: 'cn/x', rewriteSystem: (text: string) => text.replace("Anthropic's official CLI", 'an official CLI') },
  )
  assert.equal(body.messages[0].content, 'You are Claude Code, an official CLI for Claude.')
  assert.equal(body.messages[1].content, "Anthropic's official CLI for Claude")
})

test('腾讯内容指纹：Claude Code 的计费头整行被删掉，无关文本逐字符不变', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.ts')
  const real =
    "x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;\n\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\n\n后面的正文"
  const out = rewriteTencentFingerprints(real)
  assert.equal(out.split('\n')[0], "You are a Claude agent, built on Anthropic's Claude Agent SDK.")
  assert.doesNotMatch(out.toLowerCase(), /x-anthropic-billing-header/)
  assert.doesNotMatch(out, /^\s/)
  assert.match(out, /后面的正文/)
  // 大小写、版本号都不影响判定；但没这行就必须逐字符不变
  assert.equal(rewriteTencentFingerprints('X-ANTHROPIC-BILLING-HEADER: whatever'), '')
  assert.equal(rewriteTencentFingerprints('You are a Claude agent.'), 'You are a Claude agent.')
  assert.equal(rewriteTencentFingerprints('line1\nline2\n'), 'line1\nline2\n')
})

test('腾讯内容指纹：gitStatus 的主分支整句被改写，仓库上下文其余部分逐字符不变', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.ts')
  // Claude Code 在 git 仓库里注入的真实上下文（2026-10-16 本机实测抓包）
  const real = [
    'gitStatus: This is the git status at the start of the conversation.',
    '',
    'Current branch: main',
    '',
    'Main branch (you will usually use this for PRs): main',
    '',
    'Git user: mervyn',
  ].join('\n')
  const out = rewriteTencentFingerprints(real)
  assert.match(out, /Main branch \(PRs usually go here\): main/)
  assert.doesNotMatch(out, /you will usually use this for PRs/)
  // 其余行必须逐字符不变
  for (const line of [
    'gitStatus: This is the git status at the start of the conversation.',
    'Current branch: main',
    'Git user: mervyn',
  ]) {
    assert.ok(out.includes(line), `应原样保留：${line}`)
  }
  // 判据是整句：少一个词、多一个空格、换个词都不改（实测那些本来就不被拦）
  for (const untouched of [
    'Main branch: main',
    'Main branch (used for PRs): main',
    'Main branch  (you will usually use this for PRs): main',
    'Main branch (you will normally use this for PRs): main',
    'you will usually use this for PRs',
  ]) {
    assert.equal(rewriteTencentFingerprints(untouched), untouched)
  }
  // 大小写不敏感：全大写/全小写同样被拦，所以同样要改写
  assert.match(
    rewriteTencentFingerprints('MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS): main'),
    /PRs usually go here/,
  )
  assert.match(
    rewriteTencentFingerprints('main branch (you will usually use this for prs): main'),
    /PRs usually go here/,
  )
})

test('腾讯内容指纹：DSH 的 persona 与 Web GUI 两处也要改写（2026-10-22 起 cn 侧拦）', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.ts')
  // DSH（DeepSeek Harness）会话里真实的 system 片段（2026-10-22 从会话记录里取的原文）
  const real = [
    'You are an AI agent powered by DeepSeek Harness.',
    '',
    'You are a coding agent powered by the deepseek-flash model.',
    '',
    'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
    'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.',
  ].join('\n')

  const out = rewriteTencentFingerprints(real)
  assert.doesNotMatch(out, /powered by DeepSeek Harness/, 'persona 整句是判据')
  assert.match(out, /powered by a DeepSeek harness/)
  assert.doesNotMatch(out, /through the DeepSeek Harness Web GUI/, '与下一句同现才是判据')
  assert.match(out, /through the harness Web GUI/)
  // 无关行必须逐字符不变（腾讯侧按前缀缓存，无谓改动会让每轮都算新前缀）
  for (const line of [
    'You are a coding agent powered by the deepseek-flash model.',
    'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.',
  ])
    assert.ok(out.includes(line), `应原样保留：${line}`)

  // 判据是整句：拆开的片段实测都不拦，所以不该被改写
  for (const untouched of [
    'DeepSeek Harness',
    'You are an AI agent powered by DeepSeek.',
    'You are an AI agent powered by a DeepSeek harness.',
    'through the harness Web GUI',
  ])
    assert.equal(rewriteTencentFingerprints(untouched), untouched)
})

test('非腾讯 system 保留首尾空白，字符串与块数组都不 trim', () => {
  for (const system of ['  keep\n', [{ type: 'text', text: '  keep\n' }]]) {
    const result = openAiRequest({ system, messages: [{ role: 'user', content: 'hi' }] }, { model: 'oc/model' })
    assert.equal(result.body.messages[0].content, '  keep\n')
  }
})

test('缓存用量按 Anthropic 口径拆分：OpenAI 把缓存读算进 prompt_tokens，Anthropic 列出它之外', () => {
  // 上游是 OpenAI 口径（cached_tokens 是 prompt_tokens 的子集）。直接透传会让
  // Claude Code 把整段 prompt 都当成新输入，缓存看起来永远是 0。
  const outcome = outcomeOf()
  foldChunk(outcome, {
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } },
  })
  const message = anthropicMessageOf(outcome, { model: 'm', id: 'msg_c', inputTokens: 7 })
  assert.equal(message.usage.input_tokens, 100)
  assert.equal(message.usage.cache_read_input_tokens, 900)
  assert.equal(message.usage.output_tokens, 20)
  assert.equal(message.usage.cache_creation_input_tokens, undefined, '上游没报缓存写就不该编一个 0')
})

test('缓存用量：DeepSeek 的 prompt_cache_hit_tokens 与 Moonshot 的扁平 cached_tokens 都认', () => {
  const usageOf = (usage: Record<string, unknown>) => {
    const outcome = outcomeOf()
    foldChunk(outcome, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage })
    return anthropicMessageOf(outcome, { model: 'm', id: 'msg_d' }).usage
  }
  const deepseek = usageOf({ prompt_tokens: 500, completion_tokens: 1, prompt_cache_hit_tokens: 480 })
  assert.equal(deepseek.input_tokens, 20)
  assert.equal(deepseek.cache_read_input_tokens, 480)
  const moonshot = usageOf({ prompt_tokens: 500, completion_tokens: 1, cached_tokens: 300 })
  assert.equal(moonshot.input_tokens, 200)
  assert.equal(moonshot.cache_read_input_tokens, 300)
})

test('缓存用量：上游自报的缓存数超过 prompt_tokens 时不把整轮变成 500', () => {
  const outcome = outcomeOf()
  foldChunk(outcome, {
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 99 },
  })
  const message = anthropicMessageOf(outcome, { model: 'm', id: 'msg_e' })
  assert.equal(message.usage.input_tokens, 0)
  assert.equal(message.usage.cache_read_input_tokens, 10)
})

test('缓存读取与写入合计超过输入时不能上报超出总数的用量', () => {
  const outcome = outcomeOf()
  foldChunk(outcome, {
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
    },
  })
  const message = anthropicMessageOf(outcome, { model: 'm', id: 'msg_e' })
  assert.equal(message.usage.input_tokens, 0)
  assert.equal(message.usage.cache_read_input_tokens, 80)
  assert.equal(message.usage.cache_creation_input_tokens, 20)
})

test('流式请求带 stream_options.include_usage，否则纯 OpenAI 上游在流式下不回 usage', () => {
  const { body } = openAiRequest({ messages: [{ role: 'user', content: 'hi' }], stream: true }, { model: 'm' })
  assert.deepEqual(body.stream_options, { include_usage: true })
  const plain = openAiRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' })
  assert.deepEqual(plain.body.stream_options, { include_usage: true }, '非流式响应也由流式上游聚合')
})

test('流式 usage 分片在收尾时给出真实的缓存读计数', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({
    model: 'm',
    id: 'msg_u',
    inputTokens: 5,
    write: (frame: string) => frames.push(frame),
  })
  stream.push({ choices: [{ delta: { content: '好' } }] })
  stream.push({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 3, prompt_cache_hit_tokens: 380 } })
  stream.end()
  const delta = frames.find(frame => frame.includes('message_delta')) as string
  const payload = JSON.parse(delta.split('data: ')[1])
  assert.equal(payload.usage.input_tokens, 20)
  assert.equal(payload.usage.cache_read_input_tokens, 380)
  assert.equal(payload.usage.output_tokens, 3)
})

test('message_start 可以提前发：连上就握手，不等首个分片', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({
    model: 'm',
    id: 'msg_b',
    inputTokens: 42,
    write: (frame: string) => frames.push(frame),
  })
  stream.begin()
  assert.equal(frames.length, 1)
  assert.match(frames[0], /^event: message_start/)
  assert.match(frames[0], /"input_tokens":42/)
  // 幂等：之后的分片不会再发一次
  stream.push({ choices: [{ delta: { content: 'x' } }] })
  assert.equal(frames.filter(frame => frame.includes('message_start')).length, 1)
})

test('翻译出来的思考块带非空 signature：空签名会让客户端拒收自己回传的历史', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({
    model: 'm',
    id: 'msg_t',
    showThinking: true,
    write: (frame: string) => frames.push(frame),
  })
  stream.push({ choices: [{ delta: { reasoning_content: '想想' } }] })
  stream.push({ choices: [{ delta: { content: '答' } }] })
  stream.end()
  const joined = frames.join('')
  assert.match(joined, /"type":"signature_delta","signature":"AA=="/)
  const start = frames.find(frame => frame.includes('content_block_start') && frame.includes('thinking')) as string
  assert.match(start, /"signature":""/, '开场时就有 signature 字段，收尾再补 delta')
})

test('content_filter 映射成 refusal，而不是伪装成正常结束', () => {
  const translate = (finish_reason: string) => {
    const outcome = outcomeOf()
    foldChunk(outcome, {
      choices: [{ message: { content: '' }, finish_reason }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    })
    return anthropicMessageOf(outcome, { model: 'm', id: 'msg_f' }).stop_reason
  }
  assert.equal(translate('content_filter'), 'refusal')
  assert.equal(translate('stop'), 'end_turn')
})

test('模型不支持图片时，图片降级成占位文本而不是把整轮 400 掉', () => {
  const request = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  }
  const degraded = openAiRequest(request, { model: 'm', supportsImages: false }).body
  assert.equal(typeof degraded.messages[0].content, 'string')
  assert.doesNotMatch(degraded.messages[0].content, /image_url/)
  assert.match(degraded.messages[0].content, /image omitted/)
  const kept = openAiRequest(request, { model: 'm', supportsImages: true }).body
  assert.equal(kept.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
})

test('Anthropic fast mode 转成上游的 priority 通道（2026-10-27 实测 ocg 接受该字段）', () => {
  const fast = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], speed: 'fast' }, { model: 'm' })
  assert.equal(fast.body?.service_tier, 'priority')
  const plain = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' })
  assert.equal(plain.body?.service_tier, undefined, '没说要快就别加')
})

test('non-streaming usage must retain input and cache across partial chunks', () => {
  const outcome = outcomeOf()
  foldChunk(outcome, { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }, choices: [] })
  foldChunk(outcome, {
    usage: { completion_tokens: 5, prompt_tokens_details: { cached_tokens: null } },
    choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
  })
  const usage = anthropicMessageOf(outcome, { model: 'test', id: 'msg', inputTokens: 25 }).usage
  assert.equal(usage.input_tokens, 20)
  assert.equal(usage.cache_read_input_tokens, 80)
  assert.equal(usage.output_tokens, 5)
})

test('exclusive cache counts must be retained when total_tokens proves the convention', () => {
  const outcome = outcomeOf()
  foldChunk(outcome, {
    choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 90 } },
  })
  const usage = anthropicMessageOf(outcome, { model: 'test', id: 'msg' }).usage
  assert.equal(usage.input_tokens, 10)
  assert.equal(usage.cache_read_input_tokens, 90)
  assert.equal(usage.output_tokens, 5)
})

test('named or required tool choices reject undeclared or missing tools', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  assert.match(
    toOpenAiRequest({
      messages,
      tools: [{ name: 'Read', input_schema: {} }],
      tool_choice: { type: 'tool', name: 'Write' },
    }).error ?? '',
    /undeclared tool/,
  )
  assert.match(toOpenAiRequest({ messages, tool_choice: { type: 'any' } }).error ?? '', /requires at least one tool/)
})

test('streaming exclusive cache usage reports normalized input total for diagnostics', () => {
  const frames: string[] = []
  const stream = createStreamTranslator({
    model: 'test',
    id: 'msg',
    inputTokens: 25,
    write: frame => frames.push(frame),
  })
  stream.begin()
  stream.push({ choices: [], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 90 } } })
  stream.push({
    choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: null } },
  })
  stream.end()
  assert.equal(stream.usage.input_tokens, 10)
  assert.equal(stream.usage.cache_read_input_tokens, 90)
  assert.equal(stream.upstreamInputTokens, 100)
  assert.ok(frames.some(frame => frame.includes('"cache_read_input_tokens":90')))
})
