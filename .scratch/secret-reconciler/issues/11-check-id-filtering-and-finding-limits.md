# 11 — Check ID Filtering and Finding Limit

**Status:** completed
**Triage Label:** completed

## Problem Statement

When operating on large security scanner exports containing thousands or tens of thousands of findings across various detection policies, security engineers frequently need to triage, test, or reconcile only a specific subset of findings. Currently, the reconciler ingests and processes all pending findings across all provided input CSV files without any mechanism to restrict execution to specific Check IDs (such as specific high-priority secret detectors like `CKV_SECRET_1`) or to bound execution to a manageable batch size (such as the first 100 or 1,000 findings). 

Running reconciliation on an entire unfiltered dataset can result in excessive API consumption, long execution times, unnecessary LLM token expenditure, and difficulty in performing quick smoke-tests or iterative validation. Furthermore, if an operator attempts a partial run, the output CSV must not lose the unprocessed findings; it must preserve all original input rows in a `pending` status so that subsequent runs can seamlessly resume and process remaining findings per ADR 0002.

## Solution

Introduce first-class **Check ID Filtering** and **Finding Limits** configurable via environment variables (`CHECK_IDS`, `LIMIT`) and CLI options (`--check-ids`, `-n, --limit`), with CLI flags taking precedence over environment defaults. 

During ingestion, the CSV reader automatically discovers the Check ID column across multiple standard scanner header variations (`Check ID`, `Rule ID`, `Policy ID`, etc.) using normalized comparison, storing the Check ID directly on each finding. The pipeline evaluates the Check ID filter across all input CSVs first, selecting only matching candidate findings, and then bounds the active reconciliation batch to the specified `LIMIT` of pending findings. All non-selected and unreached findings are preserved in the final output CSV with status `pending`, ensuring complete data retention and full compatibility with incremental resume workflows.

## User Stories

1. As a security engineer with a 10,000-row findings CSV, I want to filter execution by one or more Check IDs in `.env` (e.g. `CHECK_IDS=CKV_SECRET_6,CKV_AWS_1`), so that the tool only fetches files and reconciles findings matching those policies.
2. As a security engineer running ad-hoc commands, I want to pass `--check-ids <ids...>` via the CLI, so that I can quickly override my `.env` defaults for a single run without editing config files.
3. As an operator running against CSV exports from different scanning vendors (Prisma Cloud, Checkov, GitHub, Azure DevOps), I want the tool to automatically detect the Check ID column whether it is named `Check ID`, `Rule ID`, `Policy ID`, `check_id`, `rule_id`, or `policy_id`, so that I do not have to manually reformat input CSV headers.
4. As a developer testing pipeline changes on a massive CSV, I want to set a batch limit (e.g. `LIMIT=100` or `-n 100`), so that only the first 100 pending findings are processed, saving time and LLM token costs.
5. As an operator specifying both a Check ID filter and a limit, I want the filter applied first and then the limit (e.g. first 100 findings matching `CKV_SECRET_6`), so that I receive a full batch of the target findings rather than slicing arbitrary rows first.
6. As a security engineer combining multiple input CSV files on the CLI (`file1.csv file2.csv`), I want the Check ID filter and Limit to apply globally across all input files in argument order, so that multi-file execution behaves consistently.
7. As an operator running an incremental batch with a limit, I want all input rows retained in the output CSV—with the unselected rows preserved in `pending` status—so that I can re-feed the output CSV into a subsequent run to resume where I left off per ADR 0002.
8. As an operator resuming a previously partially-completed CSV that contains existing `completed` rows, I want the `LIMIT` to count only new, active pending findings to process, so that already completed rows do not consume the configured batch limit budget.
9. As an operator running a job with `--check-ids` and `--limit`, I want the startup console banner to clearly display the active Check ID filter and limit settings (or indicate `(all)` / `(unlimited)` if unset), so that I have immediate operational visibility into the run configuration.
10. As a security engineer reviewing job completion, I want the final progress summary to report total input findings, matched findings count, selected active findings count, and remaining pending findings count, so that the reconciliation scope is transparent.
11. As a developer providing invalid configuration values (such as negative limits, zero limits, or non-integer strings), I want the application to fail fast with descriptive validation error messages.
12. As a developer auditing architecture decisions, I want ADR 0004 created to document the filter-then-limit execution order, full row preservation for ADR 0002 resume compatibility, and CLI/environment precedence rules.
13. As a CI engineer running automated regression tests, I want comprehensive test coverage across config validation, CSV Check ID header discovery, single/multi Check ID filtering, finding limit bounding, resume interaction, and end-to-end pipeline execution.

## Implementation Decisions

- **Domain Model & Types**:
  - Elevate `Check ID` to a first-class domain attribute on `FindingRef` (`checkId?: string`), populated during CSV ingestion.
  - Update `PipelineSummary` to track filtering and limiting metrics: `totalFindings`, `matchedCheckIds`, `selectedFindings`, `completed`, `pending`, `skipped`, and `failed`.

- **Configuration & Environment Variables**:
  - Add `CHECK_IDS` to application configuration schema: optional comma-separated list of strings, transformed into a trimmed, case-insensitive string array (`string[]`). Default: `undefined` (all check IDs).
  - Add `LIMIT` to application configuration schema: optional positive integer (`>= 1`). Default: `undefined` (unlimited).
  - Both settings are defined in the Zod configuration schema and exported on the validated configuration interface.
  - Document `CHECK_IDS` and `LIMIT` with commented examples in `.env.example` and `README.md`.

- **CLI Options & Precedence in Commander**:
  - Add `--check-ids <ids...>` to CLI arguments, accepting space-separated or comma-separated Check ID lists.
  - Add `-n, --limit <count>` to CLI arguments, accepting a positive integer.
  - CLI flags override `.env` values when specified. If CLI flags are omitted, configuration defaults to `.env` values or unrestricted defaults.

- **Dynamic Check ID Header Discovery in CSV Reader**:
  - Implement a header finder that normalizes header names (lowercase, stripped whitespace and underscores) and searches for known variants:
    - `checkid`, `check_id`, `checkids`
    - `ruleid`, `rule_id`, `ruleids`
    - `policyid`, `policy_id`, `policyids`
    - `checkname`, `check_name`, `rulename`, `rule_name`, `policyname`, `policy_name`
  - When parsing CSV rows, extract the value from the discovered column, trim whitespace, and attach it to `FindingRef.checkId`.
  - If no Check ID column is present in the CSV, `FindingRef.checkId` is `undefined`. If a Check ID filter is active, rows with undefined/empty `checkId` are treated as non-matching.

- **Pipeline Selection Logic & Filter-First Ordering**:
  - During pipeline initialization, iterate through all parsed findings across all input CSVs:
    1. Filter out findings that do not match `CHECK_IDS` (case-insensitive comparison). If `CHECK_IDS` is unset, all findings match.
    2. Among matching findings with status `pending`, select up to `LIMIT` findings for active reconciliation. Already `completed` or `failed` findings (unless `--retry-failed` is set) are preserved in their state and do not deduct from the limit budget.
    3. Group only the selected active `pending` findings into `FileWorkItem`s by Content Identity.
    4. Unselected findings remain in the master list with status `pending`.

- **Output CSV Full Retention (ADR 0002 Resume Preservation)**:
  - When generating the final results list for `writeResultsCsv`, retain every row from all input CSVs in original order.
  - Processed findings reflect their updated results (`completed`, `failed`, or `skipped`).
  - Unprocessed findings (filtered out by Check ID or excluded by limit) retain their status `pending`.

- **Observability & Progress Metrics**:
  - Startup banner displays active `Check IDs: <list>` (or `(all)`) and `Limit: <count>` (or `(unlimited)`).
  - Progress indicator and summary metrics display total findings, matched findings, processed findings, and remaining pending count.

- **Architecture Documentation**:
  - Create ADR 0004 (`docs/adr/0004-check-id-filtering-and-finding-limits.md`) detailing the architectural rationale for filter-first sequencing, output-as-input resume preservation, and dual `.env`/CLI hierarchy.
  - Update `CONTEXT.md` glossary with `Check ID Filter` and `Finding Limit`.

## Testing Decisions

- **What Makes a Good Test**:
  - Tests must verify external observable behavior (config parsing results, finding selection, pipeline metrics, and output CSV contents) without coupling to internal private helper implementations.
  - Tests must use realistic multi-row CSV fixtures with varying headers and check IDs.

- **Testing Seams**:
  - **Config Validation Seam**: Test Zod parsing for `CHECK_IDS` (comma-separated, whitespace trimming, empty handling) and `LIMIT` (positive integers, rejection of non-integers, zeros, and negative values).
  - **CSV Reader Seam**: Test ingestion of CSVs with various Check ID header names (`Check ID`, `Rule ID`, `policy_id`), verifying that `FindingRef.checkId` is extracted correctly.
  - **Check ID Filter Seam**: Test pipeline execution with single and multiple Check IDs, verifying that only matching findings are processed while non-matching rows are preserved with status `pending` in the output CSV.
  - **Finding Limit Seam**: Test pipeline execution with a limit smaller than the total pending findings, verifying that exactly `LIMIT` findings are reconciled and the rest remain `pending`.
  - **Resume Interaction Seam**: Test pipeline execution on an input CSV containing pre-existing `completed` rows with `--limit N`, verifying that N new pending findings are reconciled without completed rows consuming the limit.
  - **CLI Precedence Seam**: Test that CLI flags `--check-ids` and `--limit` properly override `.env` values.

- **Prior Art in Codebase**:
  - `src/__tests__/config.test.ts` (Zod schema validation tests)
  - `src/__tests__/csv.test.ts` (CSV streaming, dynamic header discovery, and resume status tests)
  - `src/__tests__/pipeline.merge-resume.test.ts` (Pipeline multi-file merge and resume tests)

## Out of Scope

- Regex or wildcard pattern matching for Check IDs (exact case-insensitive string matching is used).
- Limiting by unique file count / File Work Items (limit applies to findings / CSV rows).
- Dropping unselected rows from the output CSV (all rows are preserved with `pending` status for resume compatibility).

## Further Notes

- Check ID filtering and finding limits operate synergistically: an operator can filter for a specific noisy rule (e.g. `CKV_SECRET_6`) and run a limited batch of 50 to test an updated LLM prompt or TruffleHog detector configuration before rolling it out across the entire dataset.
