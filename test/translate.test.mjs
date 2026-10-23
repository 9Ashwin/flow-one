import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicMessage, createOutcome, createStreamTranslator, estimateInputTokens, foldChunk, toOpenAiRequest,
} from '../src/anthropic.mjs'

test('Anthropic 请求 → OpenAI 报文：system、块、工具、工具结果', () => {
  const { body, error } = toOpenAiRequest({
    system: [{ type: 'text', text: '你是助手' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看看这个' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '忽略我' },
          { type: 'text', text: '我来读' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }, { type: 'text', text: '继续' }] },
    ],
    tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    max_tokens: 1024,
    temperature: 0.2,
    stop_sequences: ['STOP'],
  }, { model: 'cn/deepseek-v4.1-flash' })

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
  const { body } = toOpenAiRequest({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    tool_choice: { type: 'none' },
  }, { model: 'm' })
  assert.equal(body.tools, undefined)
  assert.equal(body.tool_choice, 'none')
})

test('thinking 预算映射到档位，max_tokens 会上限截断', () => {
  const effortOf = budget => toOpenAiRequest(
    { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: budget } },
    { model: 'm' },
  ).body.reasoning_effort
  const big = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 20000 } }, { model: 'm' })
  assert.equal(big.body.reasoning_effort, 'high')
  const small = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 1024 } }, { model: 'm' })
  assert.equal(small.body.reasoning_effort, 'low')
  // 档位必须和客户端的预算表一一对应（DSH：minimal 1024 / low 2048 / medium 8192 / high 16384）
  // 以前 ≥8192 就算 high，DSH 选 low/medium 会被整体升一档（2026-10-22 真机对齐）
  assert.equal(effortOf(1024), 'low', 'DSH minimal')
  assert.equal(effortOf(2048), 'low', 'DSH low 不能变成 medium')
  assert.equal(effortOf(8192), 'medium', 'DSH medium 不能变成 high')
  assert.equal(effortOf(16384), 'high', 'DSH high')
  assert.equal(effortOf(4096), 'medium', 'Claude Code 常见的 4096 预算')
  const capped = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 }, { model: 'm', maxTokensCap: 32000 })
  assert.equal(capped.body.max_tokens, 32000)
})

test('缺 messages / 非对象请求都给出可读的 400 理由', () => {
  assert.match(toOpenAiRequest({ messages: [] }, { model: 'm' }).error, /messages/)
  assert.match(toOpenAiRequest(null, { model: 'm' }).error, /JSON object/)
})

test('流式：文本 → text_delta，收尾发 message_delta + message_stop', () => {
  const frames = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_1', write: frame => frames.push(frame) })
  stream.push({ choices: [{ delta: { content: '你' } }] })
  stream.push({ choices: [{ delta: { content: '好' } }] })
  stream.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })
  stream.end()
  const events = frames.map(frame => frame.split('\n')[0].replace('event: ', ''))
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.match(frames[0], /"input_tokens":0/)
  assert.match(frames.join(''), /"stop_reason":"end_turn"/)
  assert.match(frames.at(-2), /"output_tokens":2/)
})

test('流式：工具调用开成 tool_use 块，参数走 input_json_delta，stop_reason=tool_use', () => {
  const frames = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_2', write: frame => frames.push(frame) })
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"file' } }] } }] })
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"/a"}' } }] } }] })
  stream.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  stream.end()
  const joined = frames.join('')
  assert.match(joined, /"type":"tool_use","id":"call_a","name":"Read","input":\{\}/)
  assert.match(joined, /"type":"input_json_delta","partial_json":"\{\\"file"/)
  assert.match(joined, /"stop_reason":"tool_use"/)
})

test('流式：参数先于名字到达时先攒着，等名字到齐再开场', () => {
  const frames = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_3', write: frame => frames.push(frame) })
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] })
  assert.doesNotMatch(frames.join(''), /tool_use/, '名字没到之前不该开场')
  stream.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_b', function: { name: 'Glob' } }] } }] })
  stream.end()
  const joined = frames.join('')
  assert.match(joined, /"name":"Glob"/)
  const delta = frames.find(frame => frame.includes('input_json_delta'))
  assert.equal(JSON.parse(delta.split('data: ')[1]).delta.partial_json, '{"a":1}')
})

test('流内错误帧翻成 error 事件，且不再发 message_delta', () => {
  const frames = []
  const stream = createStreamTranslator({ model: 'm', id: 'msg_4', write: frame => frames.push(frame) })
  assert.equal(stream.push({ error: { message: '内容被安全策略拦截' } }), false)
  stream.fail(stream.failure)
  const joined = frames.join('')
  assert.match(joined, /event: error/)
  assert.match(joined, /内容被安全策略拦截/)
  assert.doesNotMatch(joined, /message_delta/)
  assert.match(joined, /event: message_stop/)
})

test('非流式归并：usage 与 tool_calls 都落到 Anthropic 消息体', () => {
  const outcome = createOutcome()
  foldChunk(outcome, {
    choices: [{ message: { content: '读到了', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"p":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  })
  const message = anthropicMessage(outcome, { model: 'cn/x', id: 'msg_5', inputTokens: 3 })
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
  const { isTencentModel, rewriteTencentFingerprints, systemRewriterFor } = await import('../src/fingerprint.mjs')
  const blocked = "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive CLI tool."
  const rewritten = rewriteTencentFingerprints(blocked)
  assert.match(rewritten, /an official CLI for Claude/)
  assert.doesNotMatch(rewritten, /Anthropic's official CLI/)
  assert.match(rewritten, /You are Claude Code,/)
  // 只有一半时不改：那两句实测本来就不被拦，改了只是白白让前缀缓存失效
  assert.equal(rewriteTencentFingerprints("You are Claude Code."), "You are Claude Code.")
  assert.equal(rewriteTencentFingerprints("You are Anthropic's official CLI for Claude."), "You are Anthropic's official CLI for Claude.")
  assert.equal(rewriteTencentFingerprints('You are terse.'), 'You are terse.')
  // 只对腾讯系模型生效
  assert.equal(isTencentModel('cn/x') && isTencentModel('workbuddy/x') && !isTencentModel('deepseek-chat'), true)
  assert.equal(systemRewriterFor('deepseek-chat'), undefined)
  assert.equal(systemRewriterFor('cn/x', false), undefined)
})

test('改写器接在请求翻译上：system 被改写，用户内容原样', () => {
  const { body } = toOpenAiRequest({
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: 'user', content: "Anthropic's official CLI for Claude" }],
  }, { model: 'cn/x', rewriteSystem: text => text.replace("Anthropic's official CLI", 'an official CLI') })
  assert.equal(body.messages[0].content, 'You are Claude Code, an official CLI for Claude.')
  assert.equal(body.messages[1].content, "Anthropic's official CLI for Claude")
})

test('腾讯内容指纹：Claude Code 的计费头整行被删掉，无关文本逐字符不变', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.mjs')
  const real = 'x-anthropic-billing-header: cc_version=2.1.301.eca; cc_entrypoint=sdk-cli;\n\nYou are a Claude agent, built on Anthropic\'s Claude Agent SDK.\n\n后面的正文'
  const out = rewriteTencentFingerprints(real)
  assert.equal(out.split('\n')[0], 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.')
  assert.doesNotMatch(out.toLowerCase(), /x-anthropic-billing-header/)
  assert.doesNotMatch(out, /^\s/)
  assert.match(out, /后面的正文/)
  // 大小写、版本号都不影响判定；但没这行就必须逐字符不变
  assert.equal(rewriteTencentFingerprints('X-ANTHROPIC-BILLING-HEADER: whatever'), '')
  assert.equal(rewriteTencentFingerprints('You are a Claude agent.'), 'You are a Claude agent.')
  assert.equal(rewriteTencentFingerprints('line1\nline2\n'), 'line1\nline2\n')
})

test('腾讯内容指纹：gitStatus 的主分支整句被改写，仓库上下文其余部分逐字符不变', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.mjs')
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
  for (const line of ['gitStatus: This is the git status at the start of the conversation.', 'Current branch: main', 'Git user: mervyn']) {
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
  assert.match(rewriteTencentFingerprints('MAIN BRANCH (YOU WILL USUALLY USE THIS FOR PRS): main'), /PRs usually go here/)
  assert.match(rewriteTencentFingerprints('main branch (you will usually use this for prs): main'), /PRs usually go here/)
})

test('腾讯内容指纹：DSH 的 persona 与 Web GUI 两处也要改写（2026-10-22 起 cn 侧拦）', async () => {
  const { rewriteTencentFingerprints } = await import('../src/fingerprint.mjs')
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
  ]) assert.ok(out.includes(line), `应原样保留：${line}`)

  // 判据是整句：拆开的片段实测都不拦，所以不该被改写
  for (const untouched of [
    'DeepSeek Harness',
    'You are an AI agent powered by DeepSeek.',
    'You are an AI agent powered by a DeepSeek harness.',
    'through the harness Web GUI',
  ]) assert.equal(rewriteTencentFingerprints(untouched), untouched)
})

test('非腾讯 system 保留首尾空白，字符串与块数组都不 trim', () => {
  for (const system of ['  keep\n', [{ type: 'text', text: '  keep\n' }]]) {
    const result = toOpenAiRequest({ system, messages: [{ role: 'user', content: 'hi' }] }, { model: 'oc/model' })
    assert.equal(result.body.messages[0].content, '  keep\n')
  }
})
