# Cache benchmarks

The benchmark makes four real model requests with a synthetic, stable system
prefix and an append-only conversation. It incurs provider usage and may hit
rate limits. The output is JSON Lines with total request duration and reported
input/cache token counts; it does not print prompts, replies, or credentials.

From a checkout of this repository, start a bridge on a chosen loopback port,
then run the following from the repository root for each source:

```sh
FO_CACHE_BENCH_API_KEY=your-local-bridge-key node scripts/cache-benchmark.ts http://127.0.0.1:8788 intl/deepseek-v4.1-flash
FO_CACHE_BENCH_API_KEY=your-local-bridge-key node scripts/cache-benchmark.ts http://127.0.0.1:8788 ocg/deepseek-v4.1-flash
```

Use the local bridge API key, not the upstream credential. A loopback bridge
without a configured key accepts the placeholder value. Compare only runs with
the same model, source, prompt shape and timing; a missing cache field is not a
zero. `total_ms` includes network and generation time and is not time to first
token. Provider cache policies can change and do not guarantee a hit.

## Local baseline: 2026-10-27

A real proxy on macOS used the same synthetic prefix, then appended each actual
assistant reply. The proxy was restarted before the fourth turn; upstream
credentials were copied to an isolated temporary home for the test.

| Source | Turn | Fresh input | Cache read | Total duration |
| --- | ---: | ---: | ---: | ---: |
| intl/deepseek-v4.1-flash | 1 | 4007 | 0 | 5329 ms |
| intl/deepseek-v4.1-flash | 2 | 183 | 3840 | 1941 ms |
| intl/deepseek-v4.1-flash | 3 | 200 | 3840 | 2207 ms |
| intl/deepseek-v4.1-flash | 4 after restart | 220 | 3840 | 6357 ms |
| ocg/deepseek-v4.1-flash | 1 | 4007 | 0 | 2629 ms |
| ocg/deepseek-v4.1-flash | 2 | 49 | 3968 | 2644 ms |
| ocg/deepseek-v4.1-flash | 3 | 59 | 3968 | 3243 ms |
| ocg/deepseek-v4.1-flash | 4 after restart | 72 | 3968 | 3811 ms |

The restart was a separate manual step in this baseline; the script above does
not stop or restart a user's service. These figures are one sample, not an SLO.
The test did not measure Claude Code's compaction, concurrent sessions, Linux,
Windows, or latency distribution.
