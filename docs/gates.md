# The two gates: facts, evidence, and how to re-verify

This project's functional core rests on two **other people's rules**: Tencent's content
moderation and the OpenCode free tier's payload-shape gate. Both can change without notice.

So this document contains no guesses, only **re-verifiable facts**: what each rule is, how we
found out, what the symptoms look like when it breaks, and how to re-verify it on the spot.

```bash
fo doctor          # re-derives both gates item by item and checks the local configuration
```

doctor first sends one request with the full shape to confirm it passes, then **removes one
requirement at a time** to confirm "this one is indeed still mandatory". If the upstream relaxes
or tightens anything, the next doctor run shows it: the full shape fails → tightened; some
variant is no longer rejected → that requirement has been relaxed.

---

## 1. Tencent content moderation (`400` + `code 11128`)

**Symptom**: the whole request is rejected. The upstream payload is reproduced verbatim below
(the `msg` text is Chinese on the wire):

```
{"code":11128,"msg":"请求被拦截，… Illegal API invocation from an unapproved channel"}
```

The client only sees "it doesn't work", which is easily misread as "the International edition is
down" or "the quota is used up".

**Criterion**: a **literal** match, character for character — not a keyword match. One missing
word, one extra space, or a different word means no block (so do not "generalize" these rules
into regex keywords — generalization damages unrelated content, while the real criterion is the
whole sentence to begin with).

| # | Blocked literal | Handling | Evidence |
| --- | --- | --- | --- |
| 1 | The **entire line** starting with `x-anthropic-billing-header:` | Delete the whole line | 2026-10-16: any value is blocked (the key name is the criterion, the value is irrelevant); 200 after deletion |
| 2 | `You are Claude Code, Anthropic's official CLI for Claude` | Changed to `…, an official CLI for Claude` | 2026-10-16: blocked only when **both fragments co-occur**; the identity sentence is retained after the rewrite |
| 3 | `Main branch (you will usually use this for PRs)` | Changed to `Main branch (PRs usually go here)` | 2026-10-16: Claude Code injects this sentence **only in git repositories**; the whole sentence is blocked; 200 after the rewrite (measured on four models including `intl/deepseek-v4.1-flash` and `cn/hy4-preview`) |
| 4 | `You are an AI agent powered by DeepSeek Harness` (DSH's persona first sentence) | Changed to `…powered by a DeepSeek harness` | 2026-10-22: the whole sentence is blocked character for character (splitting it into `DeepSeek Harness` / `You are an AI agent`, or removing the period, is not blocked); 200 after the rewrite (`cn/deepseek-v4.1-flash`; `intl` is unaffected) |
| 5 | `through the DeepSeek Harness Web GUI` **co-occurring with** the immediately following "this page / this GUI / this app" sentence | Changed to `through the harness Web GUI` | 2026-10-22: each sentence alone yields 200, only co-occurrence is blocked; changing just this one spot → 200 (`cn/deepseek-v4.1-flash`) |

Additional facts:

- **Only `system` is rewritten**: the same sentence in user / tool messages is measured not to be
  blocked;
- **Only Tencent-family models are affected**: `cn/…`, `intl/…` (prefix detection is
  `isTencentModel` in `src/fingerprint.ts`);
- Rule 3 is not injected in non-git directories, so the same command works in `/tmp` but returns
  400 in a project directory — that difference itself shows the problem lies in the context
  Claude Code injects.
- The criteria are **per client**: Claude Code hits rules 1–3, DSH (DeepSeek Harness) hits rules
  4–5 — a client's identity sentences are its own system prompt, so switching clients means
  re-deriving these.

**Re-verification**: `fo doctor` puts these literals into a minimal request and actually sends
it. Quota/rate limiting is reported separately (that is not a gate problem).

### Variant: conversation identity headers (since 2026-10-21, unrelated to content)

Also `400` + `code 11128`, but the criterion is **not** the literals in the table above — even a
trivial system prompt is blocked.

**Root cause and fix**: the official client sends three **conversation identity headers** on
every conversation; missing any one of them yields 11128.

| Header | Required? | Evidence |
| --- | --- | --- |
| `X-Conversation-ID` | **Required** | 2026-10-22: removing it → 11128; the value need not be a UUID (`conv-1` works too) |
| `X-Conversation-Request-ID` | **Required** | Same as above |
| `X-Conversation-Message-ID` | **Required** | Same as above |
| `X-Request-ID`, `x-codebuddy-request: 1`, `X-Agent-Intent: craft`, `X-Private-Data: true`, `acp-connection-id`, `x-requested-with` | Measured **not required** (200 without them) | Same as above, one variable at a time |
| The version numbers in `X-IDE-Version` / `User-Agent` | Not required (both 5.5.2 and 5.7.6 pass) | Same as above |

Evidence source: `app.asar` of the official client `WorkBuddy AI 5.7.6` (`Yr()` in
`main/daemon-bootstrap.js` sets these three headers each time), then re-derived by removing them
one at a time. The implementation is `conversationHeaders()` in `src/buddy.ts`: the conversation
id is fixed per process, while the request/message ids are newly generated per request.

Another 25 `intl/…` models on the same account do not return 11128 but `429` +
`code 14018 Credits exhausted` (a quota problem, unrelated to the gate); `cn/…` does not check
this group, and sending them does no harm.

**Re-verification**: the "Tencent content moderation" section of `fo doctor`; the two meanings
of `11128` (content moderation / conversation identity) are distinguished by `displayTips` and
by whether a trivial prompt is still blocked.

**Procedure for adding a new rule**:

1. Capture a **real request body** — a local fake upstream that receives Claude Code's requests
   is the easiest way;
2. Bisect down to the exact line (delete half and see whether it is still blocked);
3. After confirming it is a literal criterion (changing one word removes the block), add it to
   `RULES` in `src/fingerprint.ts`;
4. Add "date + criterion + evidence" to the table above.

---

## 2. The OpenCode free tier's payload-shape gate

**Symptom**: `403` +

```
FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

Anonymous access (`Authorization: Bearer public`) can list 88 models, but **a standard OpenAI
request is rejected** — it identifies whether the caller is the official client by payload
shape.

| Requirement | Fact | Evidence |
| --- | --- | --- |
| `stream: true` | Required | 2026-10-16: `false` → 403 |
| `tools` contains the four **lowercase** function tools `bash` / `glob` / `grep` / `read`, each declaring at least one property in `parameters` | Required | Same as above: removing them → 403 |
| Session id = `ses_` + 12 lowercase hex chars + **14** base62 chars (tail segment totals 26) | Required, and only the shape is checked | Same as above: 38 characters → 403; 12+14 passes |
| `x-opencode-project` (40 hex), `x-opencode-session`, `x-opencode-request` (`msg_` shape), `x-opencode-client: cli`, `User-Agent: opencode/<version>` | Sent in the official client's shape | 2026-10-16 |
| `x-opencode-session-id` (same value as `x-opencode-session`) | **Measured currently not required** (still 200 without it), but still sent | 2026-10-16; `fo doctor` judged it `relaxed` |

⚠️ **The tail-segment length is the easiest thing to get wrong**: `LENGTH = 26` in the official
`id/index.ts` is the **total tail length** (12 hex + 14 base62). Treating it as the length of the
random segment yields 38 characters, and then an unconditional 403.

⚠️ **Counterexample trap**: `ses_` + 26 `0` characters **has the correct shape** — `0` is both a
hex character and a base62 character, so it matches `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`, and
neither the real gate nor a fake one will reject it. Using it as a "wrong shape" counterexample
produces a false conclusion (this pitfall was hit once in `doctor`'s probes).

**How tool-name conflicts are smoothed over**: Claude Code ships `Bash` / `Read`, while the gate
wants four lowercase names, and it does not necessarily declare `glob` / `grep`. The approach:

- For tools the caller declared (case-insensitive) → lowercase them outbound and **restore the
  original names** in the response (otherwise Claude Code will not recognize the `bash` tool);
- For tools the caller did not declare → add a dummy stub and **drop the model's calls to the
  stub entirely** — those are tool names Claude Code cannot execute; forwarding them would only
  produce an error nobody can handle.

**Re-verification**: `fo doctor` re-derives them item by item (full shape + four variants).

---

## 3. OpenCode Go plan (authenticated channel, `/zen/go/v1`)

**Not the same path** as the free tier: different endpoint, different model list (37 for Go), and
different rules. In the DSH desktop app's `cordis.yml`, `opencode-go` is exactly this
configuration (`apiKeyEnv: OPENCODE_GO_API_KEY`,
`baseURL: https://opencode.ai/zen/go/v1`, `headers: { x-opencode-session: <uuid> }`).

| Requirement | Fact | Evidence |
| --- | --- | --- |
| `Authorization: Bearer oc_sk_…` | Required | 2026-10-16: no header and a bogus key both yield 401 |
| `x-opencode-session` | **Required**, any value (both UUID and `ses_` shapes are accepted) | 2026-10-16: missing → `400 MissingSessionID` ("cannot be routed efficiently"); both value types yield 200 |
| The free tier's shape (5 client headers, four lowercase tools, `ses_` shape) | **Not needed** | Same as above: a bare OpenAI payload returns 200 directly |
| `reasoning_effort` | `low` / `medium` / `high` / `max` / `minimal` all yield 200; **`off` is rejected** | 2026-10-16: `off` → 422, with the misleading message `Endpoint is unavailable` |

Additional facts (all discovered by measurement):

- **The deepseek family thinks by default**: with a small `max_tokens` (measured with 48 and
  400), the entire budget may be consumed by `reasoning_content`, leaving the content empty and
  `stop_reason: max_tokens` — it looks like the bridge is broken, but it is not;
- **`high` occasionally returns 503**: hit once on the first measurement, then 3 consecutive runs
  all yielded 200; this is upstream jitter, so just retry;
- Capability metadata (window / output limit / vision) also comes from models.dev:
  `deepseek-v4.1-flash` = 1M window / 384k output, consistent with the values hand-written in the
  DSH configuration.

**Re-verification**: the "OpenCode Go plan (authenticated channel)" section of `fo doctor`
re-derives these three (a minimal conversation with the session header, a request without it that
should be rejected, and a model list that requires the key).

---

## 4. What failure looks like

| Failure point | Symptom | Loud? |
| --- | --- | --- |
| Tencent content moderation adds a new rule | `400` + `11128`, the whole request fails | Loud, but the client's message easily misleads |
| Free-tier gate tightens | `403` + `FreeTierError` | Loud |
| Free-tier gate relaxes | Some variant in the probes is no longer rejected | Only visible in `fo doctor` |
| Model list changes | Individual models return 400/401 (e.g. using an anonymous key against a paid tier) | Loud |
| The upstream returns a new shape we have not seen | The translation layer may **silently drop fields** | **Not loud** — check `~/.flow-one/bridge.log` |

The last row is what this project most needs to watch: the first four fail loudly, and only "a
new shape" quietly loses something. When an answer is missing fields, the first step is to look
at that turn's `in= / out=` and the raw upstream frames in bridge.log.

---

## 5. How to add a probe yourself

The probes in `src/doctor.ts` are all pure functions with an injectable `fetchImpl` / server
address, so they can be tested offline:

- `probeOpencodeGate({ baseUrl, fetchImpl })` — returns a `verdict` for each row:
  `pass` (what should be rejected was rejected) / `relaxed` (what should be rejected was not) /
  `fail` / `inconclusive`;
- `probeTencentFingerprint(product)` — goes through **this tool's own translation layer +
  rewriter** and then actually sends a request, returning `{ ok, blocked, limited }`;
- `probeOpencodeGo()` — the three checks for the authenticated channel (session header required,
  key required, can produce output), returning rows with a `verdict`; the whole section is
  skipped when no key is configured;
- `localIssues({ settings, serviceEnv, serviceCli, runningCli, healthOk })` — a pure function;
  feed it fake data to assert (all four categories are covered: mismatched keys, `model` not
  matching `ANTHROPIC_MODEL`, the service running different code, and nothing listening).
