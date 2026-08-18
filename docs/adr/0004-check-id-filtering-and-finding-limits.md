# Check ID Filtering and Finding Limits

When operating on massive scanner exports with tens of thousands of findings across various detection rules, operators often need to reconcile a specific policy (e.g. `CKV_SECRET_6`) or test small batch sizes (e.g. 50 findings). We introduced first-class Check ID Filtering (`CHECK_IDS`, `--check-ids`) and Finding Limits (`LIMIT`, `-n, --limit`).

The pipeline evaluates the Check ID filter across all input CSVs first, selecting candidate findings matching the specified rules, and then bounds the active reconciliation batch to the configured `LIMIT` of `pending` findings. All unselected and unreached findings are preserved in the final output CSV with status `pending`, ensuring complete data retention and seamless compatibility with incremental resume workflows per ADR 0002.

## Considered Options

- **Limit before filter (row slicing first)**: Slice the first N input rows and then filter by Check ID. Rejected because arbitrary row slicing before filtering yields fewer matching findings than the configured batch budget or zero findings if the target rule appears later in the dataset.
- **Filter-then-limit (filter first, then bound batch size)**: Selects all candidate findings matching the Check ID filter first, then selects up to `LIMIT` pending findings for active analysis. Guarantees that the operator receives a full batch of the target findings up to the configured limit.
- **Drop unselected rows from output CSV**: Output only the processed rows. Rejected because partial output breaks ADR 0002 output-as-input resume workflows and loses unprocessed findings. Preserving all rows with status `pending` allows operators to re-feed the output CSV into subsequent runs to continue processing remaining findings.

## Consequences

- Filter-first ordering provides predictable batch sizes for targeted security rule triage.
- Ingestion discovers Check ID headers dynamically across diverse scanner formats (`Check ID`, `Rule ID`, `Policy ID`, `check_id`, etc.).
- Pre-existing `completed` rows from resumed CSVs do not count against the `LIMIT` budget; only active `pending` rows are consumed.
- CLI options take precedence over environment variable configuration.
- The output CSV retains all input records, with processed rows reflecting their updated statuses and unselected rows marked `pending`.
