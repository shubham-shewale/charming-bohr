# Add guarded contextual secret intelligence

TruffleHog remains the authority for credential verification. An `unverified` result is inconclusive: the value may be expired, rotated, revoked, unsupported by a live verifier, or a placeholder. Source context cannot prove which lifecycle state applies.

For `unverified` and `not_detected` findings, the Hybrid flow may call a self-hosted, OpenAI-compatible AI Gateway to produce a separate contextual plausibility assessment. The allowed classifications are `probable_secret`, `probable_false_positive`, and `uncertain`. The assessment also records file role, environment, exposure scope, principal scope, secret kind, evidence strength, and cited evidence. Path-only evidence is capped at weak confidence and cannot establish internet exposure or principal ownership.

Gateway prompts and source content are isolated by role, suspected values are redacted, and final responses use forced, schema-validated tool calls. The model starts with a small redacted window and can search or request bounded ranges only within the same already-fetched file. Every returned tool name must belong to the request's explicit application allowlist. Gateway errors or malformed responses become an uncertain manual-review outcome while preserving TruffleHog evidence.

Prompt caching remains a gateway/model capability. The client keeps versioned instructions and ordered tool schemas stable ahead of dynamic finding data, forwards an optional cache key and retention request, and records cache reads only when the gateway reports them.

When TruffleHog returns `not_detected` and the contextual result is `probable_secret`, an optional detector advisor may produce a review-only custom-detector proposal. It cannot edit TruffleHog configuration, run tools, or mark a proposal production-ready. Existing `unverified` detections are not treated as new-detector gaps.

Historical false-positive knowledge, AquaSec suppression, ServiceNow integration, automatic detector updates, and automatic remediation are intentionally outside this decision.
