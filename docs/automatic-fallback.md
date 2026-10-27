# Automatic model fallback

`fo setup` uses the stable Claude Code model `auto` whenever at least two
configured direct sources are available. The bridge selects the backend model
from an ordered list. Select `auto` under menu option 1, or run `fo use auto`, to enable this
unified entry using the saved order, or these defaults where no model was saved:

1. `intl/deepseek-v4.1-flash`
2. `cn/deepseek-v4.1-flash`
3. `ocg/deepseek-v4.1-flash`

In the interactive menu, select option 1, then `auto` and configure the fallback
order. Enter candidate numbers in priority order; omitted candidates are removed.
At least two candidates are required, and `q` cancels without saving.

For a different model or order, list explicit source/model IDs:

```sh
fo auto --fallback intl/model-a,cn/model-b,ocg/model-c
```

The configured models and order are stored in the service environment and the
installation ledger. A source that is not mounted yet is mounted automatically.
Log in to the Tencent editions and configure the OpenCode Go key separately.
The command only updates Claude Code settings already managed by this bridge;
it backs up the previous settings. `fo use <source>` adjusts the backend priority
without changing the unified Claude Code model. `fo switch` changes the selected
source's backend model while preserving the route. Re-running setup accumulates
configured sources and keeps the unified route when at least two are available.
If only one source is configured, it remains a direct model with no fallback.

For foreground use, `fo client` prints the complete command, including
`--fallback`. A manual proxy can also use:

```sh
fo serve --model auto --fallback intl/model-a,cn/model-b,ocg/model-c
```

Fallback happens only on a definite HTTP 429, authentication rejection, or a
recognized quota rejection, an explicit model-unavailable rejection, or a
known unsupported named-tool choice before generated output. Tencent may send a quota
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
system prompt rewrites. In automatic mode, older Claude Code sessions that still
send a source-prefixed model for a configured source also use the unified route;
an explicit `--map` takes precedence. Responses identify the unified `auto`
model while logs record the selected backend. A 1M client window is configured
only if every candidate has a recorded window of at least 1M. If any capability
is unknown, the client keeps the conservative default. Candidate models may
otherwise differ in image support and answers; configure equivalent models when
continuity matters.
