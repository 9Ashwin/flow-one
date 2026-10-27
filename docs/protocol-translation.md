# Protocol translation

The translation layer lives in `src/anthropic.ts`. It is a **pure data
transform**: request body in, request body out; OpenAI chunks in, Anthropic SSE
frames out. No sockets, no timers, no filesystem — which is what makes every rule
below directly testable.

For field-level mapping details see the table in
[README.md](../README.md#translation-rules). This document covers the parts that
are easy to get wrong.

## Request direction

### `system` handling

`system` is a first-class field in Anthropic but only the first message in
OpenAI. It may arrive as a string or a block array; block arrays are flattened
with `\n\n` between blocks.

The Tencent rewriter is applied **only** for Tencent-family models and **only**
when enabled. When no rewriter is supplied the outbound system text must be
byte-identical to the input — Tencent caches by prefix, and needlessly rebuilding
the string makes every turn count as a new prefix. Any change on this path needs
a regression test asserting byte equality for non-Tencent models.

### Tool results and ordering

OpenAI requires `role:'tool'` messages to follow immediately after the assistant
message that carries the matching `tool_calls`. Anthropic allows tool results and
text to be interleaved in a single user turn, so the translation emits tool
results first and the same turn's text afterwards.

An orphan `tool_result` (one whose `tool_use_id` matches no `tool_calls`) is
forwarded as-is rather than dropped: dropping it silently loses information, and
upstreams differ on whether they care.

### `tool_choice: none` with tools

`tool_choice: 'none'` together with a populated `tools` array is inexpressible in
the OpenAI shape; some upstreams reject it with a 400. The translation drops the
tool definitions in that case, keeping the `none` choice.

### Thinking budget → effort

`thinking.budget_tokens` is mapped to `reasoning_effort`, not forwarded:
Anthropic models the budget as a token count while the OpenAI wire only has
levels. The boundaries are midpoints between adjacent rows of the common client
budget tables (measured 2026-10-22 against DSH's pi-ai adapter, which sends
1024 / 2048 / 8192 / 16384):

| Budget | Effort |
| --- | --- |
| ≥ 12288 | `high` |
| ≥ 4096 | `medium` |
| otherwise | `low` |

Getting these boundaries wrong shifts every level up by one, which is what the
2026-10-22 change fixed — see the comment on `effortFor` for the measurement.

### Images

Image blocks become `image_url` parts (base64 or URL source). When the resolved
model is known **not** to accept image input, the block degrades to a text
placeholder instead: an upstream rejects the whole request with a 400 when an
`image_url` part is present, and losing the turn is worse than losing the image.
Unknown capability means "assume it works" — degrading a capable model silently
loses information.

## Response direction

### `stop_reason`

`tool_use` whenever the turn produced a tool call. Otherwise:

| OpenAI `finish_reason` | Anthropic `stop_reason` |
| --- | --- |
| `length` | `max_tokens` |
| `content_filter` | `refusal` |
| anything else | `end_turn` |

`content_filter` must **not** map to `end_turn`: an upstream that refused the turn
would then look like a model that finished without saying anything, and clients
surface those two very differently.

### Usage and cache accounting

This is the part with the largest visible effect, because the two protocols
disagree on what the numbers mean:

- OpenAI counts cache reads **inside** `prompt_tokens`.
- Anthropic lists `cache_read_input_tokens` and `cache_creation_input_tokens`
  **alongside** `input_tokens`.

Forwarding the upstream numbers unchanged makes Claude Code treat the whole
prompt as fresh input, so the cache always reads as zero. `anthropicUsageFrom`
performs the split. Field names vary by upstream, so the first numeric candidate
wins:

| Meaning | Candidates, in order |
| --- | --- |
| cache read | `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` (DeepSeek), `cached_tokens` (Moonshot) |
| cache write | `prompt_tokens_details.cache_creation_input_tokens`, `prompt_tokens_details.cache_write_tokens` (OpenRouter) |

The cache fields are written **only when the upstream reported them**: Anthropic
uses `null` for "not applicable", and a literal `0` reads as "caching exists but
never hit". An upstream that reports more cached tokens than `prompt_tokens` is
clamped rather than rejected — one miscalibrated usage block should not turn a
whole turn into a 500.

Every upstream request sets `stream_options.include_usage`, including when the
client requests a non-streaming response: the bridge still streams from upstream
and folds the result. Some OpenAI-compatible providers require this flag to send
usage. Tencent and OpenCode Go accepted it in the 2026-10-27 live checks.

Successful request logs include `cache_read`, `cache_write`, and `cache_ratio`.
`unknown` means the upstream did not report the field; it is not a zero. The
ratio divides reported cache reads by all input buckets. A process-local keyed
`prefix_id` compares the translated model, system messages, and tools without
logging their contents. It changes after restart and does not cover conversation
history or subsequent provider-specific rewrites, so a match does not guarantee
a cache hit.

### Streaming frames

```
message_start
  content_block_start → content_block_delta* → content_block_stop   (per block)
message_delta
message_stop
```

- **`message_start` is emitted on connect**, not on the first upstream chunk.
  A reasoning model can think for tens of seconds; waiting leaves the client on
  "connecting" the whole time.
- Thinking and text blocks are mutually exclusive, and block order is production
  order.
- Materialised thinking carries a `signature`. Translated thinking has no real
  upstream signature, but the field is required and must be non-empty base64;
  `AA==` is the shortest valid value and signatures are opaque to clients.
- A tool block opens with its name. Arguments that arrive before the name are
  buffered, because opening the block eagerly yields an anonymous tool call the
  client cannot send back.
- Failures after the headers are sent are reported as an in-stream `error` event
  followed by `message_stop`.

## Testing

`test/translate.test.ts` covers each rule above. When adding a rule, add the case
that fails without it; the existing cases are named for what breaks, not for what
works.
