# AGENTS.md — This repository's charter

For **people (and agents) changing this repository**. The conventions live here and the gates
are written as commands (`make verify`); when the two disagree, the commands win.

Two language rules, and they do not overlap:

- **Interactive UI stays Chinese.** Menus, prompts, wizard output, spinners — anything a person
  reads on screen while using the tool.
- **Everything else is English**: comments, JSDoc, error messages, log lines, script output,
  README/AGENTS/docs. Code, commands and identifiers are never translated.

The split is by **who consumes the string**, not by where it is printed:

| String | Language | Why |
| --- | --- | --- |
| A `menu` / `select` / `confirm` label, a wizard heading, a spinner | Chinese | A person reads it while operating the tool |
| `stdout` data (`fo status`, `fo models`) | **English** | It is data: scripts pipe it, and a machine is the consumer |
| `stderr` progress lines (`log()`) | **English** | Diagnostics belong to logs, not to the UI |
| `throw` messages and `hint` fields | **English** | The consumer is a script branching on the error contract |
| Chinese input aliases (`fo login 国内版`) | Chinese | They are **user-supplied values**, not text this program prints |

The source is TypeScript executed directly by Node (≥ 22.18 strips the types) during development.
The repository ships generated `dist/` JavaScript because Node cannot strip types under `node_modules`.
`make check` type-checks without emitting; `make verify` also builds and tests the installed shape.

---

## 1. Think before you touch anything

- If unsure, ask; do not guess. If there are several interpretations, present them rather than
  silently picking one.
- **Minimal implementation**: do not write 200 lines where 50 will do. Add no unrequested
  features and no "might be useful later" abstractions.
- Change only what must change: do not opportunistically edit neighboring code and do not
  refactor what is not broken; if you find unrelated dead code, **point it out, do not delete
  it**.
- Criterion: **every changed line must trace back to the user's request**.

## 2. Error contract (`src/errors.ts`)

**Any** failure at a command boundary must be a typed error. A bare
`throw new Error('...')` forces callers to branch on message text, which means there is no
contract at all.

| Field | Meaning | Used by |
| --- | --- | --- |
| `category` | **Closed set**: `validation` / `auth` / `config` / `network` / `upstream` / `internal` | Script branching, exit codes |
| `subtype` | Lowercase with underscores, from a closed set; constructing an undeclared subtype throws | Script branching, test assertions |
| `code` | The **upstream** numeric code (Tencent `11128`, HTTP status codes) | Diagnosing upstream problems |
| `param` | Names **only** which user input is invalid (`--port`, `BRIDGE_PORT`) | Telling the user which argument to fix |
| `hint` | The **recovery action**. Put the fix here, **not in message** | Human-readable output |
| `message` | One sentence describing what happened (may include upstream text) | Human-readable output |

**Exit codes are derived from category alone**, not from subtype or message:

| category | Exit code | When to use it |
| --- | --- | --- |
| `validation` | 2 | Invalid user input (flag, argument, model name) |
| `auth` | 3 | Not logged in, expired credentials, missing key |
| `config` | 4 | Missing or self-contradictory configuration (settings.json, service file, ledger) |
| `network` | 5 | Cannot connect, timeout, read-stream error |
| `upstream` | 6 | Explicit upstream rejection: content moderation, gate, quota, model unavailable |
| `internal` | 1 | A bug in this program (should not happen) |

The `validation`/`config` boundary is "who supplied it": values from the command line are
validation, values read from files are config. The `network`/`upstream` boundary is "did we get
a response".

### Output split

- **stdout carries success data only** (model lists, `status --as-json`); progress, warnings,
  and errors always go to stderr. That way `fo models --as-json | jq` can never be polluted by
  logs.
- Default (human-readable, stderr): `Error: <message>`, with a second line `  → <hint>` when a
  hint exists.
- `--json` (one-line envelope, stderr):
  `{"ok":false,"error":{"type":<category>,"subtype":…,"code"?,"param"?,"hint"?,"message":…}}`

## 3. Code placement table

Find the right file before you act. **Dependencies may only point from lower layers to upper
layers** (a lower number may be depended on by a higher number):

| Layer | File | Responsibility |
| --- | --- | --- |
| 0 | `src/home.ts` | Data directory and credential paths. **Deliberately imports nothing** — its entire reason for existing is to break circular dependencies |
| 0 | `src/errors.ts` | Error contract, exit codes, envelope rendering |
| 0 | `src/sse.ts` | SSE framing and "non-2xx → typed error" |
| 0 | `src/products.ts` | Constants and UA rules for the two Tencent product lines |
| 0 | `src/anthropic.ts` | Anthropic ⇄ OpenAI request translation, streaming translation, non-streaming consolidation, token estimation |
| 0 | `src/fingerprint.ts` | Content-moderation rewrites (four literal rules plus one whole-line removal) |
| 0 | `src/prompt.ts` | Terminal interaction: menus, arrow-key selection, direct number selection, secret input, spinners |
| 1 | `src/auth.ts` | Login for the two Tencent lines, credential read/write, silent renewal |
| 1 | `src/buddy.ts` | Outbound request shape for the Tencent chat surface |
| 1 | `src/opencode.ts` | OpenCode free tier (shape gate) and Go plan (session header) |
| 2 | `src/sources.ts` | Source table: prefixes, labels, default models, whether login is required |
| 2 | `src/config.ts` | Parsing and validation of flags/env/defaults |
| 3 | `src/install.ts` | Writing/restoring Claude Code settings, launchd and systemd services, `install.json` ledger |
| 3 | `src/upstreams.ts` | Source factories and the chat entry point (prefix resolution, rewriter selection) |
| 3 | `src/server.ts` | Local reverse proxy: routing, authentication, heartbeat, upstream status passthrough |
| 4 | `src/doctor.ts` | Self-check: local health checks + probes that **re-derive both gates item by item** |
| 5 | `src/wizard.ts` | Interactive wizard: one-click setup, switch model, status, restore |
| 6 | `cli.ts` | Command entry: parse arguments, render typed errors at the boundary, derive exit codes |

### Module conventions (checked by `make modules`)

- **Zero third-party runtime dependencies**: only `node:` built-ins and relative paths are
  allowed. `dependencies` must be empty; regenerate and commit `dist/` when source changes.
- **Circular dependencies are not allowed**: an ESM cycle manifests as a TDZ error
  (`Cannot access 'X' before initialization`) far from its cause. When two modules genuinely
  need each other, extract a third module like `home.ts` to break the cycle.
- **Do not solve scale by splitting packages**: a single package is a deliberate choice. For a
  file over 500 lines (soft limit), split functions or split modules first.
- New modules must also be added to the `LAYERS` table in `scripts/check-modules.ts`.
- Source imports carry the real `.ts` extension (`from './errors.ts'`). The installation build
  rewrites these relative extensions to `.js` in `dist/`.

## 4. Plan separation (hard invariant)

**The criterion is "which source this is", not the model name prefix.**

| Prefix | Source | Authentication | Content-moderation rewrite | Shape gate |
| --- | --- | --- | --- | --- |
| `cn/` | WorkBuddy China edition (CodeBuddy) | Browser authorization | **Required** | None |
| `intl/` | WorkBuddy International edition | Browser authorization | **Required** | None |
| `oc/` | OpenCode free tier | Anonymous `Bearer public` | Not required | **Required** |
| `ocg/` | OpenCode Go plan | `oc_sk_…` + session header | Not required | Not required |

The rewriter is supplied by the source itself (`systemRewriterFor` recognizes only those two
lines); when no rewriter is available, the outbound system prompt must be **byte-for-byte
unchanged**. Any change to this path must come with a regression test.

## 5. Cross-platform

- **macOS and Linux are both first-class targets**: service management (launchd / systemd
  user-level units), opening a browser (`open` / `xdg-open`), and log locations (files /
  `journalctl --user -u`) must all be implemented for both.
- `XDG_RUNTIME_DIR` must be set before `systemctl --user` (it is empty in SSH / non-login
  shells, otherwise you get `Failed to connect to bus: No medium found`, and the wizard
  falsely reports "configuration written").
  Recognize this class of "cannot connect to bus" separately and offer both paths
  (`loginctl enable-linger` followed by re-entering a login shell, or run in the foreground).
- Always use `path.join` + `os.homedir()` for paths; never hard-code platform paths.
- Platform-specific assertions go in separate files or are skipped via `process.platform`;
  shared test cases must never actually touch the local launchd/systemd.
- Verify by hand on both macOS and Linux (there is no CI to do it; testing one side is the same
  as testing neither).

## 6. Never ask the same question twice

**Do not ask again about choices that have been asked and recorded to disk**: if the background
service is already installed, just update it; if the user declined, only tell them how to enable
it (`fo setup --service`). The choice is recorded in `install.json` as `autoStart` /
`autoStartAsked`; forget it on uninstall (the next configuration should ask again). An explicit
`--service` / `--no-service` always wins.

Likewise, `status` and the wizard **must not invent fake "not logged in" signals for sources
that need no login**, and must not conflate "no service installed" with "an old service from
before the rename is still running".

## 7. Testing and verification gates

- **Every behavior change needs a regression test**, and the test name must state what breaks
  and what turns red as a result.
- Test cases **must not touch the real home directory**: always point `BRIDGE_HOME` (and
  `HOME` / `CLAUDE_CONFIG_DIR` when necessary) at a temporary directory created by
  `fs.mkdtempSync`; they must never actually invoke launchd/systemd.
- Run `make verify` before committing (= `make build` + `make check` + `make test`). **There is no CI
  backstop** (the repository has no `.github/workflows`), so the gates can only be run by hand.
- `make check` is types (`tsc --noEmit`) + lint (ESLint) + formatting (Prettier) + module
  contracts. It needs `npm install` once for the dev toolchain; `make test` does not.
- Lint findings are graded on purpose: dead bindings are **warnings** (see §1 — point out, do
  not delete), while unbalanced-promise and literal-throw mistakes are **errors**.
- Do not trust self-reports: acceptance must include **commands and output** (real-machine
  end-to-end: a real Claude Code going through one Tencent line and one OpenCode line
  respectively).

## 8. Distribution

**The release channel is the GitHub repository itself**: `npm i -g github:9Ashwin/flow-one`.
This project **does not publish to the npm registry** — a zero-dependency single package needs
no registry in the middle, and npm now requires maintainers to approve new packages with 2FA
(`E_STAGE_REQUIRED`); an extra channel is just one more place to break.

Releasing = tagging (`vX.Y.Z`) + updating `version` in `package.json`, and the two must match;
`v0.2.x` are tags of the deprecated Go implementation — do not reuse them.

The committed `dist/` snapshot is compiled from TypeScript, and `bin` points at its JavaScript.
Development still runs TypeScript directly, so `engines.node` is `>=22.18`.

## 9. Commits and communication

- Commit messages are in Chinese and explain **why** the change was made (what changed and why
  this approach), not a restatement of the diff.
- Bug-fix commits must state "symptom → root cause → fix → which test guards it".
- Comments explain "why", not a restatement of the code; record pitfalls in comments so the next
  person does not hit them again.

### Comment format

The shape follows the sibling project `floway`. The distinction is by **audience**, not by taste:

| Where | Form | Why |
| --- | --- | --- |
| Top of a file | `//` line comments | A module overview is prose, not an API contract; it stays plain text |
| An exported function, type or constant | `/** … */` | This is what an editor shows on hover, so it must be attached to the symbol |
| Inside a function body | `//` | Inline notes explain a decision at the point it was made |

Rules that follow:

- **No `@module` tags.** The file path is already the module name; a second copy drifts.
- **No decorative separators** (`// ── Section ──`, `/* ===== */`). They add a line of noise per
  section and silently go stale when the section moves. If a file needs sections to be readable,
  that is a signal to split it, not to draw a line.
- **Wrap at 100 columns** and write the reason first: what breaks, what was measured, what the
  alternative cost was. A comment that restates the next line is deleted.
- **Measured facts carry their date.** "Measured 2026-10-16: 400 + code 11128" is verifiable;
  "the upstream seems to dislike this" is not.
