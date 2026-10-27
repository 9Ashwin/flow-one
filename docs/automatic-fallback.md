# Automatic model fallback

After `fo setup` has configured Claude Code and the bridge, enable automatic
fallback with `fo auto`. Claude Code uses the stable model `auto`; the bridge
tries these sources in order, using the last model configured for each source.
When a source has no remembered model, it uses these defaults:

1. `intl/deepseek-v4.1-flash`
2. `cn/deepseek-v4.1-flash`
3. `ocg/deepseek-v4.1-flash`

For a different model or order, list explicit source/model IDs:

```sh
fo auto --fallback intl/model-a,cn/model-b,ocg/model-c
```

The configured models and order are stored in the service environment and the
installation ledger. A source that is not mounted yet is mounted automatically.
Log in to the Tencent editions and configure the OpenCode Go key separately.
The command only updates Claude Code settings already managed by this bridge;
it backs up the previous settings. Use `fo use <source>` to switch back to an
explicit source, or `fo auto` to re-enable the stored order.

For foreground use, `fo client` prints the complete command, including
`--fallback`. A manual proxy can also use:

```sh
fo serve --model auto --fallback intl/model-a,cn/model-b,ocg/model-c
```

Fallback happens only on a definite HTTP 429, authentication rejection, or a
recognized quota rejection, or an explicit model-unavailable rejection before generated output. Tencent may send a quota
error in the first SSE frames even with HTTP 200; metadata is buffered until
output starts, then forwarded normally. Once output has started, the bridge
surfaces any later error instead of replaying the request and risking duplicate
tool calls or charges. Timeouts, connection failures, ordinary invalid requests,
and content-moderation rejections do not trigger fallback.

A rate-limited model cools down for its `Retry-After` interval, or 30 seconds
when the upstream supplies no interval, bounded to one second through one day. The next
request then tries the next candidate; the preferred candidate is tried again
after cooldown. This state is process-local and resets on restart. If every
candidate is limited, the bridge returns HTTP 429 with `Retry-After`.

The bridge translates each candidate independently, including Tencent-specific
system prompt rewrites. Explicitly requested source/model IDs still target that
source. If candidate models differ, their context windows, image support and
answers may differ too; configure equivalent models when continuity matters.
