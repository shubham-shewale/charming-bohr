# 03 — LLM flow (Claude classification)

**What to build:** A second analysis flow (`FLOW=llm`) that uses Claude to classify each finding as `false_positive`, `likely_secret`, or `uncertain`. Plugs into the pipeline built in Ticket 2 — same CSV ingestion, same fetching, different analysis.

Build the Context Builder: given fetched file content and a list of finding line ranges, extract ~`SURROUNDING_LINES` lines around each finding, merge overlapping ranges to save tokens, and cap total context size. The context sent to Claude includes: repo name, file path, finding title, merged code context with line numbers annotated.

Build the Claude Analyzer using the Anthropic SDK. Send one LLM call per file for files with ≤~15 findings; batch into multiple calls for files with more. Request structured JSON output. Validate the response with Zod (classification must be one of the three enum values, confidence ∈ [0,1], reason non-empty). Handle partial batch failure: if 4 out of 5 findings parse correctly, keep those 4 and mark the invalid one as `llm_invalid_output`.

Enforce `MAX_LLM_CALLS_PER_FILE` and `MAX_TOKENS_PER_REQUEST`. Track token usage and estimated cost per request (hardcoded Haiku pricing for v1).

Write `llm_classification`, `llm_reason`, `llm_confidence` columns to the output CSV alongside the existing columns.

**Blocked by:** 02 — End-to-end TruffleHog flow

**Status:** completed

- [x] Context Builder: extracts surrounding lines, merges overlapping ranges, respects max-lines/max-bytes caps
- [x] Unit tests for Context Builder: single finding, overlapping ranges, finding at line 1, finding at EOF, adjacent ranges, exceeds file length
- [x] Claude Analyzer: Anthropic SDK client configured from `.env` (API key, model)
- [x] Prompt template: sends repo name, file path, title, merged context, line numbers; requests structured JSON with classification/confidence/reason per finding
- [x] Zod schema for LLM response validation
- [x] Partial batch failure handling: valid findings kept, invalid marked `llm_invalid_output`
- [x] One call per file (≤~15 findings), batched for files with more
- [x] `MAX_LLM_CALLS_PER_FILE` and `MAX_TOKENS_PER_REQUEST` enforced
- [x] Token usage + estimated cost tracked and printed in summary
- [x] `llm_classification`, `llm_reason`, `llm_confidence` columns written to output CSV
- [x] Integration test: mocked Anthropic SDK → correct classifications in output CSV
- [x] Integration test: malformed LLM response → partial failure handled correctly
