# 04 — Hybrid flow (LLM → TruffleHog state machine)

**What to build:** The third and primary analysis flow (`FLOW=hybrid`). Implements the explicit state machine that runs LLM classification first, then conditionally invokes TruffleHog for findings the LLM can't confidently dismiss.

State transitions:
- LLM returns `false_positive` → **DONE** (no TruffleHog)
- LLM returns `likely_secret` → invoke TruffleHog → **DONE**
- LLM returns `uncertain` → invoke TruffleHog → **DONE**

All TruffleHog outcomes (`verified`, `unverified`, `not_found`) are terminal in v1 — no second LLM pass.

The flow reuses the Claude Analyzer from Ticket 3 and the TruffleHog Runner from Ticket 2. It writes both LLM columns and TruffleHog columns to the output. The state machine should be modeled as an explicit function with clear transitions — not ad-hoc conditionals buried in the pipeline.

**Blocked by:** 02 — TruffleHog flow, 03 — LLM flow

**Status:** ready-for-agent

- [ ] Hybrid flow implementation: explicit state machine with LLM → conditional TruffleHog transitions
- [ ] `false_positive` from LLM → no TruffleHog invocation, status=completed
- [ ] `likely_secret` or `uncertain` from LLM → TruffleHog invoked, both result columns written
- [ ] LLM failure on a finding → that finding gets `status=failed`, does not trigger TruffleHog
- [ ] Both `llm_*` and `trufflehog_*` columns populated in output CSV
- [ ] Integration test: mock LLM returns `false_positive` → assert TruffleHog NOT called
- [ ] Integration test: mock LLM returns `uncertain` → assert TruffleHog IS called, both columns populated
- [ ] Integration test: mixed findings in same file — some `false_positive`, some `uncertain` — correct routing per finding
