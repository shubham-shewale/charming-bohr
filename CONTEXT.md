# Secret Findings Reconciliation

A CLI tool that processes large CSVs of secret-scanner findings, fetches the source code they reference, and classifies each finding using TruffleHog and/or an LLM.

## Language

### Findings & Identity

**Finding**:
A single row in the input CSV representing a potential secret detected by a scanner. Identified internally by its row index and source file.
_Avoid_: Alert, detection, hit

**Check ID**:
A policy or rule identifier that can appear on many findings. Not a unique finding identifier.
_Avoid_: Finding ID, detection ID

**SCM Link**:
The URL in the input CSV pointing to a specific file at a specific commit in GitHub or Azure DevOps. The primary source of truth for provider, repository, file path, revision, and line numbers.
_Avoid_: Source link, repo link, URL

### Source Identity

**Canonical Source**:
The parsed, normalized representation of an SCM link: provider, organization, repository, file path, revision (commit SHA), and line range. Used for all identity, grouping, and fetching decisions.
_Avoid_: Source identity, source key

**Content Identity**:
The subset of a Canonical Source that determines unique file content: provider + repository + revision + file path. Two findings share a Content Identity when they reference the same file at the same commit. The tool fetches once per unique Content Identity.
_Avoid_: Fetch key, cache key

### Fetching & Rate Limiting

**Token Pool**:
A round-robin set of GitHub PAT tokens used for API requests, with per-token tracking of remaining quota and reset time derived from response headers.
_Avoid_: Token manager, credential store, auth pool

**Deferred Work Item**:
A File Work Item whose fetch was blocked by a GitHub rate limit. Held aside while other providers' items continue, then retried after the rate-limit window resets.
_Avoid_: Retry item, queued item, backlog item

### Analysis

**Flow**:
One of three analysis strategies applied to findings: TruffleHog-only, LLM-only, or Hybrid (LLM first, TruffleHog on demand).
_Avoid_: Mode, strategy, pipeline

**LLM Classification**:
The three-valued result of LLM analysis: `false_positive`, `likely_secret`, or `uncertain`. Never a binary true/false.
_Avoid_: Verdict, judgment

**TruffleHog Result**:
The outcome of running TruffleHog on a fetched file: `verified`, `unverified`, or `not_found`.
_Avoid_: TruffleHog status, verification result

**File Work Item**:
A unit of work: one unique Content Identity plus all findings that reference it. The tool fetches the file once and processes all associated findings together.
_Avoid_: Task, job, work unit

### Pipeline

**Status**:
The processing state of a finding in the output CSV: `completed`, `failed`, `skipped`, or `pending`.
_Avoid_: State, result

**Source File**:
The input CSV filename a finding originated from. Used to track provenance in the merged output.
_Avoid_: Input file, origin

**Check ID Filter**:
An optional configuration that restricts active reconciliation to findings matching one or more specific Check IDs / Rule IDs. Non-matching findings are preserved in the output CSV with status `pending`.
_Avoid_: Rule selector, policy gate

**Finding Limit**:
An optional configuration bounding the active reconciliation batch to the first N pending findings. Unselected findings beyond the limit are preserved in the output CSV with status `pending`.
_Avoid_: Batch cap, row slice

