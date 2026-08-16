# Resume by re-feeding output CSV as input

Instead of maintaining a separate checkpoint file or work manifest for resume/retry, the tool's output CSV is designed to be directly re-usable as input. The output contains all original columns plus analysis result columns (`status`, `llm_classification`, `trufflehog_result`, etc.).

When the tool detects a `status` column in the input, it auto-skips rows marked `completed`. A `--retry-failed` flag additionally reprocesses rows marked `failed`. Rows without a status (or with `pending`) are always processed.

## Considered Options

- **Separate checkpoint file** (`progress.json`): More explicit, but adds file management complexity and risks the checkpoint diverging from the actual output.
- **Durable work manifest** (`.ndjson`): Enterprise-grade but overkill for a team tool used weekly.
- **Output-as-input**: Zero additional files. The output CSV is both the deliverable and the checkpoint. Simple mental model: "run again on the same file to fill in the gaps."

## Consequences

- The output CSV schema must be a strict superset of the input schema — all original columns preserved, new columns appended.
- Detection is automatic (presence of `status` column), which means accidentally passing an output file will silently skip completed rows. This is the intended behavior.
- No separate state to manage, back up, or synchronize.
