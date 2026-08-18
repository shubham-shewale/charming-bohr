# Pin and preserve the TruffleHog runtime contract

TruffleHog is the deterministic detection and verification engine in this system. Its CLI arguments and JSONL output are therefore an application contract, not an incidental subprocess detail. We pin that contract to TruffleHog `3.97.0`, validate the installed version at startup, and invoke the filesystem scanner with a positional path plus explicit `verified`, `unverified`, and `unknown` result classes. Automatic update checks are disabled and source scan errors cause a non-zero exit.

The adapter preserves verification failures as `unknown` rather than collapsing them into `unverified`. A completed scan with no overlapping detection becomes `not_detected`. Missing location metadata, multiple detections overlapping one finding, or one detection overlapping multiple findings becomes `ambiguous`. Non-zero process exits and malformed JSONL fail the work item even if partial stdout exists.

An optional `TRUFFLEHOG_CONFIG_PATH` passes a YAML configuration to the CLI so private service formats can be implemented as native custom detectors and verifiers. Raw secret values from TruffleHog output are never retained in the normalized in-memory detection model.

## Considered options

- **Track the latest CLI implicitly:** Reduces upgrade work, but allows command and output changes to alter security decisions without review.
- **Use verified-only output:** Produces a smaller result set, but makes unverified, verifier-error, and clean outcomes indistinguishable.
- **Guess correlations from missing or overlapping locations:** Maximizes automatic matches, but can attach verification evidence to the wrong finding.
- **Pin and validate a lossless contract:** Makes upgrades intentional, preserves operational uncertainty, and fails safely when evidence cannot be correlated.

## Consequences

- TruffleHog upgrades require changing the pinned version and passing unit plus real-CLI contract tests.
- Operators see additional `unknown`, `not_detected`, and `ambiguous` result values and can route them differently.
- A different or missing TruffleHog binary stops scanner-backed flows before source files are fetched.
- Custom detector configuration can be introduced without changing the process adapter.
