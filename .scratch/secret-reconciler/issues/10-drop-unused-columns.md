# 10 — Drop Unused Scanner Columns at Ingestion and Output

**Status:** completed
**Triage Label:** completed

## Problem Statement

Input CSV exports from security scanners (such as Prisma Cloud, Azure DevOps Advanced Security, and GitHub Secret Scanning) contain redundant and uninformative columns such as `title`, `severity`, `repository`, `file path`, `lines`, `first seen`, `resource`, and `policy names`. Because the reconciler derives all canonical source identity (provider, repository, file path, commit revision, and line numbers) directly from the `scm link` URL, these separate columns are completely unused for analysis and decision-making. Passing them through to the output CSV creates visual clutter and unnecessary data bloat for downstream consumers. Furthermore, if a scanner export omits some or all of these columns, the reconciler must not fail or reject the file.

## Solution

Filter out unused columns (`title`, `severity`, `repository`, `file path`, `lines`, `first seen`, `resource`, `policy names` and their normalized whitespace/underscore/case variants) at CSV ingestion time. Dropped columns are stripped from both the parsed row records and the header list, ensuring they are excluded from memory structures and never written to the output CSV. The filtering is non-fatal: if any or all dropped columns are absent in the input CSV, ingestion proceeds seamlessly. LLM classification prompts fall back to `Rule ID`, `Check ID`, `Policy ID`, or `Finding <index>` rather than relying on dropped `title` columns.

## User Stories

1. As a security engineer with raw scanner export CSVs containing `repository`, `file path`, and `lines`, I want those columns stripped upon ingestion, so that redundant data already captured in the `scm link` URL does not clutter the output.
2. As a security engineer processing CSVs with `title`, `severity`, `first seen`, `resource`, and `policy names`, I want these columns omitted from the reconciled output CSV, so that downstream reports only contain actionable classification and provenance data.
3. As an operator running the reconciler against minimal CSVs that only contain `SCM Link` (and lack `severity`, `title`, etc.), I want the tool to process findings successfully without throwing missing column errors.
4. As an operator processing CSVs where column headers have varying styles (such as `file_path`, `filePath`, `File Path`, `first_seen`, `first seen`, `policy_names`, `Policy Names`, `Policy Name`), I want the tool to recognize and strip all these variants uniformly using normalized header comparison.
5. As a security engineer whose CSV has arbitrary custom columns (such as `Account ID`, `Owner`, `Environment`, `Notes`, `Suppressed By`), I want those custom columns preserved verbatim in the output CSV, so that team-specific metadata is retained.
6. As a security engineer running LLM analysis on findings without a `title` column, I want the LLM prompt to identify checks by `Rule ID`, `Check ID`, `Policy ID`, or `Finding <index>`, so that analysis context remains accurate and descriptive.
7. As a developer auditing the codebase architecture, I want ADR 0001 updated to explicitly document that redundant scanner columns are stripped at ingestion, so that the documentation matches system behavior.
8. As a CI engineer running automated regression tests, I want tests covering CSV ingestion, column filtering, missing column resilience, and end-to-end output verification to pass reliably.

## Implementation Decisions

- **Normalized Dropped Column Denylist**: Define a canonical set of normalized column names to drop during CSV ingestion:
  - `title`
  - `severity`
  - `repository`
  - `filepath` (matching `file path`, `file_path`, `filepath`)
  - `lines` / `line`
  - `firstseen` (matching `first seen`, `first_seen`, `firstseen`)
  - `resource`
  - `policynames` / `policyname` (matching `policy names`, `policy_names`, `policy name`, `policy_name`)

- **Ingestion-Time Filtering in CSV Reader**:
  - In the CSV reader module, after reading the raw header row, filter out any column whose normalized name matches an entry in the dropped column denylist.
  - For each parsed record, omit keys matching dropped columns so that `rawRow` contains only retained input columns.
  - Return only the filtered headers in `ReadCsvResult.headers`.
  - Treat all dropped columns as optional: absence of any or all dropped columns produces no warnings or errors.

- **Output CSV Writer Behavior**:
  - The CSV writer constructs output headers by merging the retained input headers with the reconciler result columns (`source_file`, `status`, `trufflehog_result`, etc.).
  - Because dropped columns are removed from `headers` and `rawRow` at ingestion, they are automatically excluded from the final output CSV.

- **LLM Analyzer Prompt Fallback**:
  - Update the title lookup in the LLM analyzer to check `Rule ID`, `Check ID`, and `Policy ID` (falling back to `Finding <index>`), removing reliance on the dropped `title` column.

- **Architecture Documentation**:
  - Amend ADR 0001 (`docs/adr/0001-scm-link-as-primary-source.md`) to record that redundant scanner columns (`repository`, `file path`, `lines`, etc.) are dropped at ingestion rather than preserved in output.

## Testing Decisions

- **Testing Seams**:
  - **CSV Reader Seam**: Test reading CSVs containing all dropped columns, verifying that `ReadCsvResult.headers` and `FindingRef.rawRow` omit all dropped columns while preserving retained columns.
  - **CSV Writer & Integration Seam**: Test writing findings to an output CSV and running the full pipeline end-to-end, verifying that dropped columns never appear in the output CSV headers or row records.
  - **Absence Resilience Seam**: Test CSVs missing all dropped columns, partial subsets, or only containing `SCM Link`, verifying zero errors.
  - **Header Variant Seam**: Test various casing and underscore/space combinations (`file_path`, `FILE PATH`, `Policy Names`, `policy_name`, `FIRST_SEEN`), verifying all are stripped.

## Out of Scope

- User-configurable custom column drop lists via CLI flags or environment variables (the denylist is fixed to the standard scanner redundant columns).
- Dropping custom non-scanner metadata columns (e.g. `Account ID`, `Notes`, `Team`).
- Modifying SCM URL parsing logic.

## Further Notes

- By dropping redundant columns at ingestion, memory overhead per `FindingRef` is reduced when processing massive multi-megabyte CSV exports with hundreds of thousands of rows.
