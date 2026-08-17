# GitHub Token Pool and rate-limit deferral

GitHub's API enforces a 5,000-request-per-hour limit per PAT. A single reconciliation run can easily exceed this when processing large CSVs with thousands of GitHub SCM links. We decided to support multiple comma-separated PATs in `GITHUB_PAT`, rotated round-robin through a `TokenPool` class that tracks each token's remaining quota and reset timestamp from response headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`). When all tokens are exhausted, the pipeline defers affected GitHub work items, continues processing Azure items, then sleeps until the earliest reset window and retries — up to a configurable `GITHUB_RATE_LIMIT_MAX_RETRIES` (default 2).

## Considered Options

- **Drain-first (use token A until exhausted, then B):** Maximizes the window where at least one token is fresh, but causes bursty exhaustion and makes the deferral window longer.
- **Least-remaining (always pick the token with the most budget):** Adaptive, but adds per-request bookkeeping and the response-header race with concurrent requests makes it unreliable.
- **Serialize GitHub requests to avoid races:** Eliminates the possibility of wasted 403s from concurrent requests seeing stale remaining-counts, but kills throughput for a problem that only surfaces near exhaustion.
- **Internal retry within FileFetcher:** Hides deferral from the pipeline, making rate-limit behaviour invisible and hard to debug or test.

We chose round-robin for its simplicity and predictability — both tokens deplete evenly, making timing analysis straightforward. A shared `isBlocked` flag on `TokenPool` lets the pipeline skip remaining GitHub items immediately rather than wasting requests on 403s. The typed `GitHubRateLimitError` bubbles up to the pipeline, keeping the fetcher layer free of orchestration concerns.
