# flow-one

A local reverse proxy that lets the **Claude Code CLI** use **WorkBuddy (the CodeBuddy China
edition and the International edition)** and the **OpenCode free tier**.

中文说明见 [README-cn.md](README-cn.md).

Claude Code only speaks Anthropic's Messages protocol, while these services expose OpenAI-style
APIs (WorkBuddy's `/v2/chat/completions`, OpenCode's `/inference/v1/chat/completions`).
This bridge does exactly one thing: **Anthropic on the way in, OpenAI on the way out** — and
handles login, token renewal, the model catalog, the free tier's shape gate, and environment
isolation along the way. Zero dependencies, Node built-ins only.

```
Claude Code CLI ──► this bridge 127.0.0.1:8788 ──► WorkBuddy China copilot.tencent.com    cn/…
   (Anthropic            /v1/messages            (OpenAI-shaped SSE)
    Messages)            ⇄ translate           ──► WorkBuddy International www.workbuddy.ai intl/…
                                               ──► OpenCode free tier opencode.ai/inference oc/…
```

## Installation

**Not published to the npm registry — install straight from GitHub.** The repository includes
a generated JavaScript snapshot, so installation needs no build step or third-party runtime
dependencies. Node ≥ 22.18 is required.

```bash
npm i -g --install-links github:9Ashwin/flow-one      # installs the flow-one and fo commands
```

If you would rather not install it globally, fetch it on each run:

```bash
npx -y github:9Ashwin/flow-one status
```

To modify the code, clone the repository and run the TypeScript source directly:

```bash
git clone https://github.com/9Ashwin/flow-one.git
cd flow-one && node cli.ts
```

**Updating**: rerun the same installation command.
**Pinning**: `npm i -g --install-links github:9Ashwin/flow-one#v0.3.1`.
The existing `v0.3.0` tag predates the JavaScript snapshot and does not work as a global install;
the `v0.2.x` tags are the deprecated Go implementation.

> Why not publish to npm: npm no longer allows publishing a new package directly with
> credentials; it must be staged first and approved by the maintainer with 2FA
> (`E_STAGE_REQUIRED`). A single zero-dependency package does not need a registry in the middle
> anyway — installing from GitHub is the same one command.

## Quick start

```bash
fo               # run it in a terminal to open the interactive menu
```

After choosing `1`, it walks through four steps by itself: **which upstream → login → model
selection → write configuration and run as a service**.

Configure one upstream at a time (like zcf, one item at a time). When it finishes, **press Enter
to return to the menu**; to attach another upstream, pick "one-click setup" again — the mounted
list is **cumulative** (the union of `BRIDGE_PRODUCTS`), so earlier configuration is not
displaced.

Once you have configured an upstream, **switching channels no longer requires this flow**:

```bash
fo use cn      # switch to the China edition
fo use intl    # switch to the International edition
fo use ocg     # switch to the OpenCode Go plan
```

`fo use` does exactly three things: point the client configuration at that source, add its model
prefix to the service's mounted list, and restart the service. It **does not ask about login,
client, or auto-start** — those are already configured. It switches to **the model that line
last used** (or the recommended order if none is recorded), so switching back and forth does not
reset you to the default every time.

The menu is localized in Chinese; the following is the actual terminal output.

```
  ──────── 第 1 步 · 接哪一家 ────────
? 接哪一家？  ↑↓ 选择，或直接按编号，回车确认
❯ 1. WorkBuddy 国内版（CodeBuddy）  cn 阿斯温月
  2. WorkBuddy 国际版  intl starry99c@163.com
  3. OpenCode 免费档  oc 无需登录，免费模型
  4. 转发给已有的 OpenAI 兼容网关  自建网关 / LiteLLM / Ollama

✔ 接哪一家？ OpenCode 免费档

  ──────── 第 2 步 · 登录 ────────
✔ OpenCode 免费模型 无需登录，直接可用

  ──────── 第 3 步 · 模型 ────────
? 用哪个模型？  直接敲字筛选，↑↓ 选择，回车确认
  直接敲字筛选 · 共 89 项
  ──── 免费模型（13 个） ────
❯  1. oc/deepseek-v4.1-flash-free  免费 · 窗口 200k · 输出 32k · 视觉
   2. oc/big-pickle  免费 · 窗口 200k · 输出 32k
   3. oc/beam-free  免费 · 窗口 1.0M · 输出 131k
   …
  ──── 其余模型（75 个，按量计费 / 订阅） ────
```

Step 2 deals only with the chosen upstream: the OpenCode free tier has no login step, so
selecting it jumps straight to model selection; the two Tencent product lines go through browser
authorization here.

Model selection lists only **that upstream's** models (configure one upstream at a time instead
of picking from all sources). The list is **complete and never truncated**, and the **free tier
forms its own group at the top** (OpenCode's free models consume no credits/quota); metered or
subscription models come after. Group headings are only headings: they take no number and the
cursor skips over them.

The list also supports **type-to-filter**: typing `free`, `glm`, or `oc/deep` narrows it
immediately. Backspace deletes, Esc clears, ↑↓ moves, Enter confirms (group headings are no
longer inserted into filtered results). Above 12 entries, only the segment around the cursor is
drawn. IDs that are missing from the list (self-hosted gateways, new models) go through the last
entry, "manually enter a model ID".

List-style selections (model catalogs) use ↑↓ or **the number keys directly**; there is no
need to remember spacebar shortcuts, and every row carries the context window, output limit, and
effort level. A summary box is shown at the end.

Once configured, just run `claude`. To revert: choose "restore configuration" in the menu, or
run `fo uninstall`.

## Two kinds of upstream

| | Direct mode (default) | Gateway mode |
| --- | --- | --- |
| Who handles login | **This tool itself**; the OpenCode free tier needs no login at all | The upstream does, e.g. [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |
| Dependencies | None | That gateway must be running |
| Model IDs | `cn/deepseek-v4.1-flash`, `intl/hy4-preview-f`, `oc/deepseek-v4.1-flash-free` | Upstream IDs, e.g. `workbuddy/deepseek-v4.1-flash` |
| Best for | Installing only this tool | Already running a gateway / mixing multiple upstreams |

One prefix per source, so **a single process can serve three lines at once**; changing
`ANTHROPIC_MODEL` changes the source:

| Prefix | Source | Login |
| --- | --- | --- |
| `cn/` | WorkBuddy China edition (CodeBuddy, `copilot.tencent.com`) | Required |
| `intl/` | WorkBuddy International edition (`www.workbuddy.ai`) | Required |
| `oc/` | **OpenCode free tier** (`opencode.ai/inference`) | **Not required**; works right after installation |
| `ocg/` | **OpenCode Go plan** (`opencode.ai/zen/go/v1`) | Requires an API key (`oc_sk_…`) |

### OpenCode Go plan (`ocg/`)

If you have bought the Go plan (from $10/month), choose "one-click setup → OpenCode Go plan" in
the menu and paste the `oc_sk_…` key (input is not echoed). Once configured, **an additional
source is mounted automatically**, and the model list shows 37 models with the `ocg/` prefix:
DeepSeek V4.1 Flash / Pro, GLM-5.1/5.2/5.3, Kimi K3, Grok 4.6/4.7, Qwen3.8, Claude Haiku 5.5,
Gemini 4 Argon…

This path is **not the same** as the free tier and follows different rules (measured 2026-10-16;
the DSH desktop app's `cordis.yml` uses the same configuration):

| Fact | Notes |
| --- | --- |
| Endpoint `/zen/go/v1` | The free tier uses `/inference/v1`; the two paths expose different model lists |
| `Authorization: Bearer oc_sk_…` required | No header or a bogus key both yield 401 |
| **`x-opencode-session` required** | Without it the response is `400 MissingSessionID` ("cannot be routed efficiently"); the value is an arbitrary session id — both UUID and `ses_` shapes are accepted — and the bridge generates one on first setup, persists it, and reuses it |
| The free tier's shape is **not needed** | A bare OpenAI payload returns 200 directly; no need to add the four lowercase tools or send `x-opencode-client` |

Two practical details: the upstream **does not accept** `reasoning_effort: "off"` (422, with the
misleading message "Endpoint is unavailable"), so this bridge's effort mapping only sends
`low/medium/high`; the deepseek family **thinks by default**, so a small `max_tokens` may be
entirely consumed by reasoning and leave the content empty — when debugging with a reduced
`max_tokens`, that is easy to misread as "the bridge is broken".

### OpenCode free tier (`oc/`)

`oc/deepseek-v4.1-flash-free` is DeepSeek V4.1 Flash from the official free tier and needs no
account. But it is **not "just a different base URL"**: a standard OpenAI request is rejected
with

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

— it identifies the caller by **payload shape**. Measured (2026-10-16): all three of the
following are needed to get a 200:

- five `x-opencode-*` headers: `project` (40 hex), `session` **and** `session-id` (the same
  value), `request`, `client: cli`, plus `User-Agent: opencode/<version>`;
- session id shape `ses_` + 12 lowercase hex chars + **14** base62 chars (tail segment totals 26;
  mistaking it for "26 random chars" yields 38 characters and an unconditional 403);
- request body with `stream: true`, and `tools` must contain the four lowercase function tools
  `bash` / `glob` / `grep` / `read`.

Tool name conflicts are smoothed over by this bridge: Claude Code's own `Bash` / `Read` are
lowercased on the way out and renamed back in the response; tools it did not declare (usually
`glob` / `grep`) get a stub, and the model's calls to the stub are **dropped entirely** — those
are tool names Claude Code cannot execute.

**The complete facts, evidence, and re-verification procedure for these two gates are in
[docs/gates.md](docs/gates.md)**; `fo doctor` **re-derives them item by item** (the Go plan path
included: a minimal conversation with the session header, a request without it that should be
rejected, and a model list that requires the key). It first verifies the full shape and then
removes one requirement at a time to confirm it is still mandatory — so upstream relaxation or
tightening shows up immediately, instead of waiting for users to report "it doesn't work".
Models ending in `-free` such as `big-pickle` work the same way; those without `-free`
(`deepseek-v4.1-flash`, `deepseek-v4-pro`, etc.) belong to the $10/month OpenCode Go
subscription, and using them reports `AuthError`.

## Command line

`fo` is used throughout below; `flow-one` is equivalent.

| Command | Description |
| --- | --- |
| `fo` | Runs the menu in a terminal; without a TTY (systemd / pipes) it starts the service directly |
| `switch` | Changes only the model (the menu's "switch model") |
| `use <cn\|intl\|oc\|ocg>` | Changes only the channel: switches to an already-configured source, uses the model it last used, and restarts the service |
| `doctor` | Self-check: configuration / login / both gates (actually sends a few requests) |
| `setup` / `--setup` | Interactive one-click setup (asks **once each** whether to write the Claude Code and DSH configurations) |
| `client` | Prints connection details (address / token / model ID) for you to enter in the client yourself |
| `uninstall` / `--uninstall` | Restores the Claude Code configuration and uninstalls the background service |
| `login [cn\|intl]` | Login; with no argument it logs in to both product lines |
| `status` | Login status, token expiry, service and configuration file locations |
| `models` | Lists available model IDs (with context window / output limit / effort level) |

If you prefer not to use the wizard, every step can be done with flags:

```bash
node cli.ts --mode gateway --upstream http://127.0.0.1:8326 \
             --model workbuddy/deepseek-v4.1-flash --port 8788 --api-key "$(openssl rand -hex 16)"
```

| Option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--mode` | `BRIDGE_MODE` | `direct` | `direct` connects to Tencent products / `gateway` forwards to an upstream |
| `--product` | `BRIDGE_PRODUCTS` | `cn,intl,oc` | Which sources to mount; one-click setup **appends** to it, and it can be repeated |
| `--host` | `BRIDGE_HOST` | `127.0.0.1` | Listen address |
| `--port` | `BRIDGE_PORT` | `8788` | Listen port |
| `--model` | `BRIDGE_MODEL` | Empty in direct mode / `workbuddy/deepseek-v4.1-flash` in gateway mode | Fallback model ID |
| `--map` | `BRIDGE_MODEL_MAP` | Empty | Model mapping in the form `A=B,C=D` |
| `--api-key` | `BRIDGE_API_KEY` | Empty (no check) | The bridge's own access key; `setup` writes the fixed default `flow-one-local` on first run and **reuses it** thereafter (clients reference it for the long term; rotating it randomly makes Claude Code return 401 and DSH report "invalid key") |
| `--max-tokens` | `BRIDGE_MAX_TOKENS_CAP` | 0 (unlimited) | Per-response output cap before forwarding |
| `--heartbeat` | `BRIDGE_HEARTBEAT_MS` | 15000 | Interval for ping frames during silent thinking periods; 0 disables |
| `--thinking` | `BRIDGE_SHOW_THINKING` | Off | Renders upstream reasoning deltas as `thinking` blocks |
| — | `BRIDGE_FINGERPRINT_REWRITE` | On | Narrow Tencent content-fingerprint rewrite (see below) |
| `--upstream` | `UPSTREAM_BASE_URL` | `http://127.0.0.1:8326` | OpenAI-compatible upstream for gateway mode |
| `--upstream-key` | `UPSTREAM_API_KEY` | Read from the DSH gateway key | Upstream key |
| — | `BRIDGE_HOME` | `~/.flow-one` | Credentials and installation state directory |

Listening on a non-loopback address requires a custom `--api-key` / `BRIDGE_API_KEY`; an empty
key and the public default `flow-one-local` are rejected. Authentication-free listening is
allowed only for literal loopback IPs (IPv4 `127.0.0.0/8` or IPv6 `::1`); hostnames require a
custom key even when they currently resolve to loopback, so that a resolution change cannot
widen the access surface.

## What it actually changes

**The tool's job is to provide the proxy; modifying your client configuration is optional.** The
wizard's step 4 **asks twice, separately**: whether to write the Claude Code configuration
(`~/.claude/settings.json`) and whether to write the DSH one (`llm-pi-ai` provider + credential
reference) — two independent switches; answering y to both writes both. **Every setup asks**
(the previous choice is the default); answering n to both writes no client configuration
(including previously managed configuration). After changing parameters such as the bridge port,
clients that were not updated must be synchronized manually. `--clients claude,dsh|claude|dsh|none`
states the choice directly and skips the question.
Afterwards `fo client` prints the connection address, token, and model ID at any time for you to
enter in any Anthropic-compatible client.

If you choose "write", the wizard touches only three places, all reversible:

1. **`~/.claude/settings.json`** (only if you chose "write"; backed up first as
   `settings.json.bak-<timestamp>`) — it merges only the 6 `ANTHROPIC_*` keys under `env`;
   existing `permissions`, `hooks`, `statusLine`, `ANTHROPIC_CUSTOM_HEADERS`, etc. are preserved
   as-is.
   If your `model` is an alias such as `sonnet`, it is pinned to our model as well, so Claude
   Code does not request an alias that does not exist in the gateway.
   On restore, it **deletes only keys whose value still equals the one this tool wrote** —
   values you changed yourself are kept.
2. **The background service**: on macOS it writes
   `~/Library/LaunchAgents/dev.flow-one.plist` and runs `launchctl bootstrap`; on Linux it writes
   a unit under `~/.config/systemd/user/` and runs `systemctl --user enable` + `restart`. Mode,
   upstream, and model are written into the service environment, so the service gets the same
   configuration when started without arguments.
3. **`~/.flow-one/`**: login credentials (0600), `install.json` (records which keys were written
   and which service was installed, for restoration), and service logs.

### The `[1m]` suffix on model IDs

`[1m]` is a Claude Code marker meaning "this model is registered with a 1M context".
**This tool decides whether to add it based on the model's real context window**: it is added
only above 200k, and not added when unknown (Claude Code's default assumption for an
unrecognized ID is exactly 200k).

This is not pedantry: the measured context window of OpenCode's free-tier
`deepseek-v4.1-flash-free` is **200k** (capability data comes from models.dev; the official
`/v1/models` contains no capability fields). Registering it as 1M would make Claude Code compact
context only at 1M and then hit the model's real limit. The two Tencent lines really do have 1M
windows, so they keep the suffix. Claude Code strips the suffix before sending, so the upstream
receives a clean ID.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages, streaming and non-streaming (`?beta=true` is also accepted) |
| POST | `/v1/messages/count_tokens` | Local estimate; no upstream request is made |
| GET | `/v1/models` | Upstream model list (with product prefixes in direct mode) |
| GET | `/health` | Liveness probe; **no key required** |

Authentication accepts both `x-api-key` and `Authorization: Bearer`, compared in constant time;
when `--api-key` is empty no check is performed (in that case it listens on loopback only — do
not change it to `0.0.0.0`).

## Translation rules

| Anthropic | OpenAI |
| --- | --- |
| `system` (string or block array) | First `{role:'system'}` message |
| `text` / `image` blocks | `{type:'text'}` / `{type:'image_url'}` parts |
| `tool_use` blocks | `tool_calls[]` on the assistant message |
| `tool_result` blocks | Separate `{role:'tool', tool_call_id}` message (placed before same-turn text) |
| `tools[].input_schema` | `tools[].function.parameters` |
| `thinking.budget_tokens` | `reasoning_effort` (≥8192 → high, ≥2048 → medium, otherwise low) |
| `stop_sequences` | `stop` |

On the response side, `stop_reason` is determined by whether this turn contains tool calls
(`tool_use` if so); otherwise `length → max_tokens` and everything else `end_turn`. Streaming is
framed as `message_start → content_block_start → content_block_delta → content_block_stop →
message_delta → message_stop`; tool arguments use `input_json_delta`; failures after response
headers have been sent are reported as an in-stream `error` event.

Direct mode additionally does four things only official clients do:

1. **The first message must be `system`** — the International gateway answers
   `400 + code 11128` to a request whose first message is `user`, so one is added when missing.
2. **`prompt_cache_key`** — the same system prefix consistently hits the server-side prefix
   cache (the official client measured roughly a 17× billing difference for the same request
   with the cache enabled).
3. **Choose `User-Agent` by model family** — the International backend groups its "client
   usage" statistics by this; the domestic model lines `glm-*` / `hy*` / `kimi-*` / `minimax-*`
   must be sent with the domestic client shape.
4. **The DeepSeek family needs thinking enabled explicitly** — only `reasoning_effort` takes
   effect for this family; the `thinking` field alone has no effect, and both are needed to
   reliably get `reasoning_content` back.

## Narrow rewrites for Tencent-side content moderation

The Tencent backend blocks requests that "claim to be another client". This bridge applies five
narrow rewrites, **each backed by a measurement**, to **Tencent-family models** (`cn/`, `intl/`,
`buddy/`, `workbuddy/` prefixes); all other text is left character-for-character unchanged
(Tencent caches by prefix, and needlessly rebuilding the string makes every turn count as a new
prefix):

| Literal matched | Handling | Measured evidence |
| --- | --- | --- |
| `You are Claude Code, Anthropic's official CLI for Claude` | Changed to `…, an official CLI for Claude` | Original sentence → `400 + 11128`; half of it alone is not blocked, so the rule requires both fragments |
| `Main branch (you will usually use this for PRs)` | Changed to `Main branch (PRs usually go here)` | Claude Code injects this only inside a git repository; the whole sentence is blocked, 200 after the rewrite |
| `You are an AI agent powered by DeepSeek Harness` | Changed to `… powered by a DeepSeek harness` | DSH's persona line; split into fragments it is not blocked, so the match is the whole sentence |
| `through the DeepSeek Harness Web GUI` | Changed to `through the harness Web GUI` | Blocked only when it appears together with the previous line |
| A whole line `x-anthropic-billing-header: …` (Claude Code 2.1.x puts it on the first line of the system prompt) | The entire line is removed | The key name is the criterion (case-insensitive, any value); renaming or deleting it yields 200 |

To turn it off: `--no-fingerprint-rewrite` or `BRIDGE_FINGERPRINT_REWRITE=0`.
**Weigh this yourself**: it is a workaround for a vendor-side content control, only so that
third-party clients such as Claude Code can be used (see the disclaimer at the end).

## Known limitations

- **Gateway mode depends on that gateway running.** It points at DSH's `127.0.0.1:8326` by
  default, which is a listener inside the desktop app process: if DSH is closed, the bridge has
  no upstream. Use direct mode for full independence.
- **Reasoning is not rendered to clients by default** (only with `--thinking`).
- **`tool_choice` is not forwarded** (the official client never sends it; with `none`, tool
  definitions are removed as well).
- **Images in tool results** are sent in the OpenAI multipart format, which standard servers may
  not accept.
- **Non-streaming requests are still streamed upstream**, and this bridge consolidates them into
  a single JSON response.
- **`count_tokens` is an estimate** (4 characters ≈ 1 token; images count as a fixed value).
- **The `[claude-code:unrecognized_model]` diagnostic line still appears in `-p` mode.**
  The official workaround is to key `modelOverrides` by Claude model IDs — which amounts to
  making Claude Code believe it is running Opus and inheriting that model's window and behavior.
  That is not worth paying for one line of stderr noise. In interactive sessions the line is not
  printed; it only goes to the debug log.
- **The OpenCode free tier passes the gate on payload shape**, so an official tightening could
  break it (in that case it reports `FreeTierError` explicitly rather than degrading silently).
  It only covers the free tier; models not ending in `-free` require an OpenCode Go subscription.
- **Which code the service runs depends on how it was installed**: with a global install
  (`npm i -g`), the service points at the `dist/cli.js` **snapshot** under
  `…/lib/node_modules/…/dist/cli.js`, and later `git pull`s or repository edits have no effect
  (the symptom is "the CLI has a new feature but the service doesn't"). `fo status` prints the
  service's code path and warns with a reinstall hint when it differs from the current command.
- Covers conversations and the model catalog only. **Daily check-in for credits is out of
  scope.**

## Tests

```bash
node --test        # fully offline, no network or account needed
fo doctor         # the only check that really sends requests (both gates + local configuration)
```

33 test cases, all offline: pure functions in the translation layer, gateway mode end to end
(fake upstream SSE), direct-mode login polling (including `11217` not yet ready), model catalog
merging and filtering, in-stream policy blocks reported faithfully, fingerprint rewriting, the
installer's "merge rather than overwrite / back up before writing / restore only our own keys /
service file contents", key and number-key selection in the terminal UI, and the OpenCode free
tier's gate shape (session/request id lengths, adding and renaming gate tools, dropping stub
calls, end-to-end never leaking to the client).

⚠️ The UI test cases live separately in `test/prompt.test.ts` and **do not touch the global
`process.stdin`**: `src/prompt.ts` exposes a `setStdinForTest()` seam for them to swap the input
stream. Previously they modified `process.stdin` directly, which disturbed node:test's result
accounting — adding one such case to the same file made the file's total count decrease, with
nothing abnormal visible in the logs.

The "declared case count" and "actually registered count" of each file can be cross-checked like
this (the format string is Chinese, matching the terminal output the script prints):

```bash
for f in test/*.test.ts; do
  printf '%-28s 声明 %s / 注册 %s\n' "$f" "$(grep -c '^test(' $f)" \
    "$(node --test --test-reporter=tap $f 2>/dev/null | grep -oE '^# tests [0-9]+' | grep -oE '[0-9]+')"
done
```

Verified on real hardware (2026-10, local machine): a real `claude` CLI (2.1.301) got answers
through this bridge; gateway mode against a real upstream for non-streaming / streaming / tool
round-trips; `/v2/plugin/auth/state` address discovery for both Tencent product lines; the
OpenCode free tier for non-streaming / streaming / tool round-trips (the model sends `bash`, the
bridge returns `Bash`); launchd auto-start and `/health`.

## Disclaimer

This project accesses interfaces used by the official clients **through your own account
credentials** and is intended for personal learning and personal use only. Judge for yourself
whether this complies with the requirements of your region and the terms of service; do not
commit credentials to any repository, and do not expose this bridge to the public internet.
Protocol details reference reverse-engineering findings that were empirically verified in
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) (MIT); this project's
implementation is independent of it.

## Publishing to npm (maintainers)

The package name `flow-one` is **not yet taken** on npm (checked 2026-10-16). The name `fo` is
already taken by someone else, so it exists only as a command alias provided by this package,
not as the package name.

```bash
# 0. Prerequisite: the registry must be the official one — mirrors can install but not publish
npm config get registry          # should be https://registry.npmjs.org/

# 1. Log in (register at npmjs.com first if you have no account)
npm login                        # a one-time code is required with 2FA enabled

# 2. Dry run first: runs prepublishOnly (node --test) and lists what will be published
npm publish --dry-run

# 3. Publish for real
npm publish

# 4. Verify
npm view flow-one version
npm i -g flow-one && fo status
```

A few pitfalls encountered:

- **The working tree must be clean before publishing**: uncommitted changes make it into the
  published package as half-finished work.
- **Version numbers only go up**: run `npm version patch|minor|major` first; republishing the
  same version is rejected (`EPUBLISHCONFLICT`).
- **Unpublishable only within 72 hours**: `npm unpublish flow-one@0.1.0`; after that you can
  only publish a new version. So before the first release, `npm i -g .` to verify locally is
  safer.
- **Publishing from CI** requires an **Automation**-type token (npm website → Access Tokens);
  regular tokens are rejected by 2FA. Store it as the repository secret `NPM_TOKEN` and run
  `npm publish --provenance --access public` when a `v*` tag is pushed. Say the word if you want
  this workflow and I will add a `.github/workflows/release.yml`.

## License

MIT

## Code conventions and gates

This repository's conventions live in [AGENTS.md](AGENTS.md) (error contract, code placement
table and layering, plan-separation invariants, cross-platform requirements, testing and
verification gates). Supporting documents:

| Document | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | The charter: rules a change must satisfy, and the gates that enforce them |
| [docs/architecture.md](docs/architecture.md) | Layers, request path, where state lives, failure taxonomy |
| [docs/protocol-translation.md](docs/protocol-translation.md) | Translation rules that are easy to get wrong |
| [docs/gates.md](docs/gates.md) | The two upstream gates: measured facts, evidence, re-verification |
| [docs/development.md](docs/development.md) | Setup, running, gates, where a change goes |
| [README.zh-CN.md](README.zh-CN.md) | Chinese README |

**The gates are written as commands**, run in one go:

```bash
make verify     # run this before committing = build + static checks + all unit tests
make check      # static checks only: types + lint + formatting + module conventions
make test       # tests only (node --test, zero dependencies)
make types      # tsc --noEmit against the TypeScript sources
make lint       # ESLint
make format     # Prettier, in place
make help       # list all targets
```

`make check` needs `npm install` once for `typescript`, `eslint` and `prettier`. Running the
bridge and running the tests do not: `node cli.ts` and `node --test` use only Node built-ins.

A few deliberate constraints:

- **Zero third-party dependencies**: only `node:` built-ins. An empty `dependencies` is central to
  the installation experience — one `npm i -g github:9Ashwin/flow-one` is all it takes.
- **Single package, no splitting**: about 4000 lines across 17 modules is fine as one package;
  splitting into workspaces or multiple published packages would only turn "install one thing"
  into "resolve a pile of packages", plus another npm publish review for every new package.
  Solve scale with smaller functions and modules; `make check` warns when a file exceeds 500
  lines.
- **Circular dependencies are not allowed**: an ESM cycle manifests as a TDZ error, far from its
  cause, so the machine guards it (`scripts/check-modules.ts`). `src/home.ts` deliberately
  imports nothing; its whole purpose is to break the `config ↔ opencode` cycle.
- **Every behavior change comes with a regression test**, and test cases must not touch the real
  home directory (always use a temporary `BRIDGE_HOME`).
