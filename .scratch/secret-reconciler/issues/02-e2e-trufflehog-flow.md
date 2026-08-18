# 02 — End-to-end TruffleHog flow (GitHub only)

**What to build:** The first demoable pipeline. Given a CSV with GitHub-hosted findings, the tool streams it, groups findings by unique file, fetches each file from GitHub, runs TruffleHog, and writes a merged output CSV with verification results.

Specifically: stream-read the CSV with a mature streaming parser (e.g. `csv-parse`), discover headers dynamically (case-insensitive, whitespace-trimmed), normalize each row into a `FindingRef`. Parse each row's SCM link using the GitHub parser from Ticket 1 — rows with unparseable links get `status=skipped`. Group findings by Content Identity (`provider::org/repo::revision::filePath`). For each unique Content Identity, under bounded concurrency (`p-limit` controlled by `CONCURRENCY`), fetch the raw file from the GitHub REST API using the commit SHA, with an in-flight promise cache to deduplicate concurrent requests for the same file. Save fetched files to `tmp/` in the project root.

Run `trufflehog filesystem --file {path} --json` on each fetched file as a subprocess. Parse TruffleHog's JSON output and match detections back to indexed findings by line-range overlap. Produce a `FindingResult` for each finding.

Write a merged output CSV preserving all original columns plus: `source_file`, `status`, `trufflehog_result`, `trufflehog_detector`, `error`. Auto-generate the output filename with a timestamp unless `--output` is specified.

**Blocked by:** 01 — Scaffold + config + GitHub SCM parser

**Status:** done

- [x] Streaming CSV reader with dynamic header discovery (case-insensitive, whitespace-trimmed column names)
- [x] Rows normalized into `FindingRef` with parsed `CanonicalSource`; unparseable SCM links → `status=skipped`
- [x] Findings grouped by Content Identity into `FileWorkItem` map
- [x] GitHub `SourceProvider`: fetches raw file content via REST API at specific commit SHA, using `GITHUB_PAT`
- [x] In-flight promise cache: `Map<ContentKey, Promise<string>>` prevents duplicate concurrent fetches
- [x] Fetched files saved to `tmp/` in project root
- [x] TruffleHog subprocess runner: invokes `trufflehog filesystem --file {path} --json`, handles timeout/exit-code/stderr
- [x] TruffleHog output matched to findings by line-range overlap
- [x] `FindingResult` produced per finding with status + TruffleHog columns
- [x] Output CSV writer: preserves all original columns, appends result columns, auto-generates timestamped filename
- [x] Bounded concurrency via `p-limit` from `CONCURRENCY` env
- [x] Integration test: CSV in → mocked GitHub fetch → mocked TruffleHog subprocess → output CSV assertions
