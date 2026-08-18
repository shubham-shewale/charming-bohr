# Make Hybrid analysis verification-first

The Hybrid flow must establish deterministic scanner evidence before asking an LLM for semantic false-positive context. TruffleHog therefore runs once for every pending finding in a File Work Item before any LLM request.

The state machine treats `verified`, `unknown`, and `ambiguous` as terminal outcomes. Verified credentials must not be sent to an external model. Verifier operational failures remain `unknown`, and unsafe detection-to-finding correlations remain `ambiguous`; neither can be converted into a false positive by model output. Only `unverified` and `not_detected` findings are passed to the LLM, and their TruffleHog result and detector are preserved when the classification is merged.

TruffleHog execution failure fails the affected pending findings without invoking the LLM. An LLM failure affects only the findings routed to it and retains their scanner evidence for retry or manual review.

## Considered options

- **LLM first, scanner on demand:** Saves scanner calls, but allows an LLM false-positive classification to bypass deterministic verification.
- **Run both engines for every finding:** Preserves verification, but sends verified credential context unnecessarily and spends LLM budget without adding decision value.
- **Verification first with selective LLM fallback:** Makes scanner evidence authoritative while limiting semantic analysis to unresolved false-positive cases.

## Consequences

- Hybrid runs TruffleHog for every pending finding and may use more scanner capacity than the previous LLM-first flow.
- Verified, unknown, and ambiguous findings produce no LLM token usage.
- LLM configuration is no longer required for `trufflehog-only` runs, and the pipeline does not construct an LLM client for that flow.
- Existing consumers retain the `hybrid` flow name, but its execution order and cost profile change.
