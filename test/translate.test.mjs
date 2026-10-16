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
  const big = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 20000 } }, { model: 'm' })
  assert.equal(big.body.reasoning_effort, 'high')
  const small = toOpenAiRequest({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 1024 } }, { model: 'm' })
  assert.equal(small.body.reasoning_effort, 'low')
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
