# 06 — Two-CSV merge + resume

**What to build:** Two features that complete the input/output story:

**Two-CSV merge:** The CLI accepts two positional CSV arguments (e.g., `npx secret-reconciler unsuppressed.csv suppressed.csv`). Both are streamed and their rows interleaved into the index. Each row is tagged with its `source_file` (the input filename it came from). The output is a single merged CSV with a `source_file` column. Both CSVs may have slightly different header schemas (e.g., one has `Suppressed By`, the other doesn't) — the output should be the union of all columns, with empty values for columns absent in a given input.

**Resume (output-as-input):** When the input CSV contains a `status` column (detected automatically during header discovery), the tool recognises it as a previous output being re-fed. Rows with `status=completed` are skipped — they're not added to the work index, and they're written directly to the output with their existing result columns preserved. With `--retry-failed`, rows with `status=failed` are also reprocessed (re-added to the work index). Rows with `status=pending`, `status=skipped`, or no status are always processed.

**Blocked by:** 02 — End-to-end TruffleHog flow

**Status:** ready-for-agent

- [ ] CLI accepts two positional CSV arguments
- [ ] Both CSVs streamed; each row tagged with `source_file` = input filename
- [ ] Header union: output columns = union of both inputs' columns + result columns; missing columns filled with empty
- [ ] Output CSV has `source_file` column correctly populated
- [ ] Resume detection: `status` column present in input → auto-skip `completed` rows
- [ ] Skipped rows written directly to output with existing result columns preserved verbatim
- [ ] `--retry-failed` flag: `failed` rows reprocessed when flag is present, skipped otherwise
- [ ] Rows with `pending`, `skipped`, or empty status are always processed
- [ ] Integration test: two CSVs with different columns merged into one output
- [ ] Integration test: re-feed output → completed rows skipped, pending rows processed
- [ ] Integration test: `--retry-failed` → failed rows reprocessed, completed still skipped
