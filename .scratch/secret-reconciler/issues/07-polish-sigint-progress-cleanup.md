# 07 — Polish: SIGINT, progress, file-size skip, cleanup

**What to build:** Production-readiness features for comfortable weekly use:

**SIGINT handling:** On Ctrl+C (SIGINT/SIGTERM), the tool stops accepting new file work items, waits briefly for any in-flight work to finish (with a short timeout), flushes all completed results to the output CSV, cleans up `tmp/` files, and exits with a non-zero code. Partially-processed findings get `status=pending` so they'll be picked up on a resume run. The output CSV is never left in a corrupted state.

**Progress:** During processing, print periodic progress to the terminal: files processed / total files, findings completed / total findings, tokens used so far, estimated cost so far. Keep it simple — one-line updates, not a fancy TUI.

**File-size skip:** After fetching a file, check its size against `MAX_FILE_SIZE_KB`. If exceeded, mark all findings for that file as `status=skipped` with an error message indicating the file was too large. The file is still cleaned up normally.

**Cleanup:** At end of run, delete the `tmp/` directory and all fetched files. If `--keep-files` flag is present, skip cleanup and print the `tmp/` path so the user can inspect files.

**Auto-generated output filename:** If `--output` is not specified, generate `results-{YYYYMMDD}T{HHMM}.csv` in the current working directory.

**Blocked by:** 02 — End-to-end TruffleHog flow

**Status:** ready-for-agent

- [ ] SIGINT/SIGTERM handler: stops new work, flushes completed results, cleans up, exits non-zero
- [ ] In-flight work on SIGINT: brief timeout, then unfinished findings written as `status=pending`
- [ ] Output CSV never left corrupted after SIGINT
- [ ] Progress output: periodic one-line terminal updates (files, findings, tokens, cost)
- [ ] `MAX_FILE_SIZE_KB` check after fetch: oversized files → all findings `status=skipped` with error
- [ ] `tmp/` cleanup at end of run
- [ ] `--keep-files` flag skips cleanup, prints path
- [ ] Auto-generated output filename: `results-{timestamp}.csv` when `--output` not specified
- [ ] Integration test: SIGINT during processing → output CSV written, no corruption
- [ ] Integration test: file exceeding size limit → findings skipped with appropriate error
