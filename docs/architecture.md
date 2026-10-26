# Architecture

How the pieces fit together and **why they are cut this way**. The rules a
change must satisfy are in [AGENTS.md](../AGENTS.md); this document explains the
shape that those rules protect.

## The one job

```
Claude Code CLI ──► this bridge 127.0.0.1:8788 ──► upstream (OpenAI-shaped SSE)
   (Anthropic Messages)   /v1/messages
```

The client speaks Anthropic Messages; every upstream speaks OpenAI Chat
Completions. Everything else — login, token renewal, the model catalogue, the
free tier's shape gate, the file writes — exists to keep that one translation
honest.

## Layers

Imports may only point **from a lower layer to a higher one**, which is what
`scripts/check-modules.ts` enforces. The numbering below matches its `LAYERS`
table.

| Layer | Modules | Responsibility |
| --- | --- | --- |
| 0 | `home`, `errors`, `sse`, `products`, `anthropic`, `fingerprint`, `prompt`, `atomic`, `types` | Pure utilities. No knowledge of who the upstream is. |
| 1 | `auth`, `buddy`, `opencode` | One upstream each: credentials and the outbound request shape. |
| 2 | `sources`, `config` | Which sources exist, and how flags/env/defaults resolve. |
| 3 | `install`, `dsh`, `upstreams`, `server` | Assembly: source factories, the HTTP server, files written to disk. |
| 4 | `doctor`, `switch` | Checks and switching, which touch files and the ledger but not the terminal. |
| 5 | `wizard`, `use` | Interaction. |
| 6 | `cli` | Argument parsing, typed-error rendering, exit codes. |

Two rules of thumb that follow from the table:

- **A module that needs to know about a specific upstream belongs in layer 1.**
  Layer 0 code receives the upstream's quirks as arguments (a `rewriteSystem`
  callback), never as a branch on the vendor.
- **`home` deliberately imports nothing.** It exists to break the
  `config ↔ opencode` cycle; a TDZ error from a cycle reports its site far from
  its cause, which is why the rule is machine-checked rather than reviewed.

## The request path

1. `server` routes the request, authenticates it, and reads the body with a
   32 MiB cap.
2. `resolveModel` maps the client's model name to an upstream ID: explicit
   `modelMap` first, then the live catalogue, then the configured default, then
   the first catalogue entry. Claude model names always take the fallback path.
3. `anthropic.toOpenAiRequest` translates the body. It is a pure function —
   no sockets, no timers, no filesystem — so the translation is directly
   testable.
4. `upstreams` picks the source from the model prefix and sends the request.
   Non-2xx becomes a typed result, not an exception.
5. **Only after the upstream answers** does `server` write response headers.
   This is the reason a 401/429/400 reaches Claude Code as its real status code
   instead of a 200 followed by an apology in the stream.
6. For streaming, `createStreamTranslator` renders OpenAI chunks as Anthropic
   events. `message_start` goes out on connect, before the first chunk, because a
   reasoning model can think for a long time without emitting anything.

## Where states live

| State | Where | Lifetime |
| --- | --- | --- |
| Credentials | `~/.flow-one/credentials.json` (0600) | Until logout |
| Installation ledger | `~/.flow-one/install.json` | Until uninstall |
| OpenCode identity | `~/.flow-one/opencode.json` | Across restarts — a new id per restart looks like a new client to the upstream |
| Model catalogue | In memory, 60 s TTL, single-flight | Process |
| Everything else | Environment variables and flags | Process |

There is deliberately no configuration file. The bridge's whole configuration is
"which upstream, which port"; keeping it in flags and environment variables
means one source of truth when it is also written into Claude Code's
`settings.json`.

## Failure taxonomy

Every failure at a command boundary is a `BridgeError` with a closed
`category`, and **the exit code is derived from the category alone**:

| Category | Exit | Boundary |
| --- | --- | --- |
| `validation` | 2 | Command line gave something invalid |
| `auth` | 3 | Not logged in, expired credentials, missing key |
| `config` | 4 | Settings, service file, or ledger is missing or contradictory |
| `network` | 5 | Could not connect, timed out, read failed |
| `upstream` | 6 | The upstream answered, and the answer was a refusal |

`validation` versus `config` is decided by *who supplied the value*: the command
line is `validation`, a file is `config`. `network` versus `upstream` is decided
by *whether an answer arrived*.

Inside the server the same split appears in a different form: before headers are
sent, failures are HTTP status codes; after headers are sent, the only remaining
channel is an in-stream `error` event. That is why retries and candidate
exhaustion all happen before the first byte goes out.

## Why there is no build step

The source is TypeScript, and Node ≥ 22.18 strips the types when loading it.
`tsc --noEmit` is a checker, not a compiler: `make types` runs it, nothing
produces a `dist/`. The consequences are deliberate:

- `npm i -g github:9Ashwin/flow-one` installs runnable code, with no `prepare`
  script and no toolchain on the user's machine.
- Relative imports carry the real `.ts` extension, because that is the specifier
  Node resolves on disk; there is no extension rewriting to hide the mismatch.
- `engines.node` is `>=22.18` rather than the old `>=18.17`. A lower floor would
  install cleanly and then fail on first run with a syntax error, which is a
  worse experience than refusing to install.
