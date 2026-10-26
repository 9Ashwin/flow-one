# Development

Setting up, running, and verifying a change. For the rules themselves see
[AGENTS.md](../AGENTS.md); for how the code is laid out see
[architecture.md](architecture.md).

## Requirements

- **Node ≥ 22.18** — the source is TypeScript executed directly, via Node's
  native type stripping.
- No package manager is required to *run* the bridge or the tests. `npm install`
  is only needed for the static checks (types, lint, formatting).

## Getting set up

```bash
git clone https://github.com/9Ashwin/flow-one.git
cd flow-one
npm install          # dev toolchain only
npm link             # optional: makes `fo` point at this working tree
```

`npm link` means `git pull` takes effect immediately, which is the fastest loop
for changing the bridge. Without it, use `node cli.ts …` directly.

## Running

```bash
node cli.ts                 # interactive menu
node cli.ts models          # list model IDs (stdout is parseable)
node cli.ts status --as-json
node cli.ts doctor          # the only command that really sends requests
```

## Gates

`make verify` is the one command to run before committing. It is `make check`
plus `make test`.

```bash
make check      # types + lint + formatting + module contracts
make test       # node --test, offline
make verify     # both
```

| Target | What it proves |
| --- | --- |
| `make types` | `tsc --noEmit` is clean under `strict` |
| `make lint` | ESLint reports no errors |
| `make format-check` | Files match the Prettier configuration |
| `make modules` | No cycles, no third-party imports, layer direction respected |
| `make test` | The whole offline suite passes |

**There is no CI backstop.** The repository ships no `.github/workflows`, so
these gates only run when someone runs them.

## Where a change goes

The placement table in AGENTS.md §3 is the authority. The short version:

- A new upstream → a layer-1 module implementing `chat` / `listModels`, plus an
  entry in `sources.ts` and a line in the `LAYERS` table.
- A new flag → `config.ts` (both the `FLAGS` map and the `USAGE` text), plus a
  row in both READMEs.
- A new endpoint → `server.ts` routing, with the auth check ordered correctly.
- A protocol nuance → `anthropic.ts`, and a case in `test/translate.test.ts`.

## Tests

Tests live in `test/` and run under `node --test`. Conventions:

- **Never touch the real home directory.** Point `BRIDGE_HOME` (and `HOME` /
  `CLAUDE_CONFIG_DIR` when the code path reads them) at a directory from
  `fs.mkdtempSync`.
- **Never invoke launchd or systemd.** `install.ts` has a guard
  (`assertScratchServicePath`) that fails the test if a real service file would
  be written; do not bypass it by loosening the guard.
- **Each test name states what turns red.** "Bug: X happens when Y" is the
  pattern; a name that only says "works" tells the next person nothing.
- UI tests that take over stdin live in their own file (`test/prompt.test.ts`),
  because leaving them in a shared file disturbs `node:test`'s accounting.

## Committing

Commit messages are written in Chinese (the repository's convention) and explain
**why** the change was made, not what the diff shows. A bug fix states the
symptom, the root cause, the fix, and which test guards it.

## Releasing

Tag `vX.Y.Z` and update `version` in `package.json`; the two must match.
Distribution is the GitHub repository itself — see AGENTS.md §8.
