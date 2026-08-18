# 09 — GitHub Token Pool, Rate-Limit Deferral & Cross-Run File Cache

**Status:** ready-for-agent
**Triage Label:** ready-for-agent

## Problem Statement

The secret reconciler uses a single GitHub PAT with a 5,000-request-per-hour rate limit. When processing large CSVs with thousands of GitHub SCM links, the tool exhausts its quota mid-run, causing all remaining GitHub File Work Items to fail. Operators must wait for the rate-limit window to reset and manually re-run with `--retry-failed`. Additionally, when operators choose to keep temp files between runs (`CLEANUP_TEMP_FILES=false`), subsequent runs re-fetch files that are already on disk from the previous run, wasting both time and rate-limit budget.

## Solution

Support multiple comma-separated GitHub PATs in the `GITHUB_PAT` environment variable, rotated round-robin through a Token Pool that tracks each token's remaining quota and reset time from GitHub's response headers. When all tokens are exhausted, the pipeline defers affected GitHub File Work Items, continues processing Azure items, then sleeps until the earliest rate-limit window resets and retries — up to a configurable maximum number of retry passes. Before any remote fetch, the file fetcher checks whether the file already exists on disk from a prior run, eliminating redundant API calls.

## User Stories

1. As a security engineer with a large GitHub finding backlog, I want to provide two GitHub PATs in a comma-separated `GITHUB_PAT` value, so that I have 10,000 requests per hour instead of 5,000.
2. As a security engineer running a scan that exceeds the rate limit, I want the tool to automatically defer GitHub File Work Items and continue processing Azure items, so that Azure findings are not blocked by GitHub's quota.
3. As a security engineer whose GitHub rate limit is hit mid-run, I want the tool to sleep until the rate-limit window resets and retry deferred items automatically, so that I don't need to manually re-run.
4. As an operator processing a very large backlog, I want a configurable cap on retry passes (`GITHUB_RATE_LIMIT_MAX_RETRIES`), so that the tool doesn't run indefinitely if the backlog far exceeds my aggregate token budget.
5. As an operator who has exhausted retries, I want deferred items to be marked `failed` with a clear rate-limit error, so that I can re-run them later with `--retry-failed`.
6. As a security engineer running back-to-back scans on overlapping CSVs, I want the tool to reuse files already fetched in a previous run from the shared `tmp/` directory, so that I save API calls and processing time.
7. As an operator running with `CLEANUP_TEMP_FILES=true`, I want all cached files in `tmp/` to be deleted after the run, so that my workspace stays clean.
8. As an operator running with `CLEANUP_TEMP_FILES=false`, I want cached files to persist in `tmp/` across runs, so that subsequent runs benefit from the cache.
9. As a security engineer, I want tokens to be rotated round-robin across requests, so that both tokens deplete evenly and rate-limit windows align predictably.
10. As a security engineer running at high concurrency, I want the tool to read `X-RateLimit-Remaining` and `X-RateLimit-Reset` from every GitHub response and track them per token, so that quota state is always current.
11. As an operator, I want the tool to immediately skip all remaining GitHub items once a rate limit is detected (via a shared `isBlocked` flag), so that it doesn't waste hundreds of requests on 403 responses.
12. As an operator, I want clear log messages when deferral happens ("GitHub rate limit hit — deferred N items, retrying after reset at TIME") and when sleeping ("Sleeping Xs until GitHub rate limit resets..."), so that I understand what the tool is doing.
13. As an engineer running existing workflows with a single `GITHUB_PAT` value, I want the system to work identically to before without any configuration changes, so that existing setups do not break.
14. As an engineer running with `CONCURRENCY=5`, I want occasional 403 races (two concurrent requests both see remaining=1) to be handled gracefully by deferring the failed item, so that no findings are lost.

## Implementation Decisions

- **Configuration**: `GITHUB_PAT` accepts a comma-separated string of one or more PATs, parsed and trimmed at config load time into `githubPats: string[]`. A new optional `GITHUB_RATE_LIMIT_MAX_RETRIES` integer (≥ 0, default 2) is added to `AppConfig`.

- **Token Pool module**: A new `TokenPool` class in the providers layer. Pure state machine — no HTTP knowledge. Public API:
  - `getToken(): string` — returns the next token via round-robin index.
  - `reportUsage(token, remaining, resetAt)` — updates per-token rate-limit state from response headers.
  - `isBlocked: boolean` — true when every token has `remaining === 0` and its reset time hasn't passed.
  - `getEarliestReset(): number` — UTC epoch seconds of the soonest token reset, used by the pipeline to compute sleep duration.
  - `resetBlockedState()` — clears blocked state after sleeping past the reset window.

- **Rate-limit error type**: A new `GitHubRateLimitError extends Error` carrying `resetAt: number` (UTC epoch seconds) and `tokenIndex: number` (for diagnostics). Thrown by the GitHub provider on 403/429 responses.

- **GitHub provider return shape change**: `fetchGitHubFile` returns `{ content: string; rateLimitRemaining: number; rateLimitReset: number }` instead of a bare string. Parses `X-RateLimit-Remaining` and `X-RateLimit-Reset` from response headers. On 403/429, throws `GitHubRateLimitError` using the reset header (or `Retry-After` if present).

- **FileFetcher integration**: Accepts a `TokenPool` instead of a raw `githubPat` string. On GitHub fetches: calls `tokenPool.getToken()`, passes it to the provider, then calls `tokenPool.reportUsage()` with the returned rate-limit fields. Re-throws `GitHubRateLimitError` to the pipeline.

- **Cross-run file cache**: The temp directory changes from per-run `tmp/run-{timestamp}-{random}/` to a shared flat `tmp/` directory. Before any remote fetch, `fetchFile()` checks if the content-identity-hashed file already exists on disk and returns it immediately if so. The content identity includes the commit SHA, so cached files are immutable by definition — no integrity verification needed.

- **Pipeline defer-and-revisit loop**: All work items (GitHub and Azure) enter the main `p-limit` pass together. Each GitHub executor checks `tokenPool.isBlocked` before calling the API — if blocked, the item is immediately pushed to a `deferredGithubItems` array without a network call. If `fetchFile` throws `GitHubRateLimitError`, the item is also deferred (not marked failed). After the main pass, if deferred items exist, the pipeline sleeps until `tokenPool.getEarliestReset()` (plus a 1-second buffer), resets blocked state, and retries. This repeats up to `githubRateLimitMaxRetries` times. Any items still deferred after all retries are marked `failed` with a rate-limit error message.

- **Concurrency model**: Best-effort — no per-token serialization. Occasional 403 races under high concurrency are caught and deferred, same as a genuine exhaustion.

## Testing Decisions

- **What makes a good test**: Tests verify observable behavior through existing execution seams — not internal state. A good test provides inputs (config, mock provider responses, filesystem state) and asserts outputs (returned paths, thrown error types, final CSV status values, log messages).

- **Modules to be tested**:
  - **TokenPool** (direct unit tests): Round-robin ordering across N tokens, `isBlocked` transitions on `reportUsage`, `getEarliestReset` accuracy, `resetBlockedState` clearing, single-token backward compatibility.
  - **GitHub provider** (via `vi.stubGlobal("fetch")`): Rate-limit header parsing from mock responses, `GitHubRateLimitError` thrown on 403/429 with correct `resetAt`, `Retry-After` header fallback, return shape `{ content, rateLimitRemaining, rateLimitReset }`.
  - **FileFetcher** (via `fetchProvider` injection): Cross-run cache hit (pre-existing file on disk → zero fetch calls), cache miss → fetch, `GitHubRateLimitError` propagation, TokenPool `reportUsage` called after successful fetch.
  - **Pipeline** (via `PipelineOptions.fetchProvider`): Defer-and-revisit loop end-to-end — mock provider that returns rate-limit errors for GitHub items, verify deferred items retried after simulated sleep, verify max retry cap, verify remaining items marked failed.

- **Prior art**:
  - `file-fetcher.test.ts` for `fetchProvider` injection and deduplication assertions.
  - `config.test.ts` for Zod environment variable parsing.
  - `integration.test.ts` and `pipeline.mixed.test.ts` for multi-provider pipeline tests.

## Out of Scope

- GitHub App authentication (15k/hour) as an alternative to PATs.
- Azure DevOps rate-limit handling (Azure DevOps does not expose comparable rate-limit headers).
- Persistent on-disk cache index or manifest file — the file's existence at the expected hash-based path is the only index.
- Eviction or TTL-based expiry of cached files.
- Secondary GitHub rate limits (concurrency-based abuse detection) — only primary per-hour quota is tracked.

## Further Notes

- GitHub returns rate-limit headers on every response, including error responses. The Token Pool should update state even on 403/429 to capture the `X-RateLimit-Reset` value.
- With 2 PATs and default max retries of 2, the tool can handle up to ~30,000 GitHub file fetches per run (3 windows × 10,000 requests). Operators with larger backlogs should consider GitHub App tokens or splitting their CSVs.
- The cross-run cache naturally reduces rate-limit pressure: overlapping SCM links across CSVs or retry runs hit the cache instead of the API.
