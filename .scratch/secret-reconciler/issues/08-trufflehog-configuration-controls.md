# 08 — TruffleHog Configuration Controls: Verification Mode, User-Agent, and Timeout

**Status:** ready-for-agent
**Triage Label:** ready-for-agent

## Problem Statement

When using Secret Reconciler with TruffleHog (in both `trufflehog-only` and `hybrid` flows), operators lack configuration controls over TruffleHog subprocess behavior from `.env`. Specifically:
1. **Verification noise vs. network overhead**: Operators cannot control whether TruffleHog performs live API verification (`all`), only outputs confirmed active credentials (`verified-only`), or disables network calls completely (`no-verification`) to save rate limits and scan offline.
2. **Audit tracking & User-Agent identification**: Security teams cannot append custom identifiers to TruffleHog's outgoing HTTP traffic to attribute scanner requests in target service audit logs (e.g., AWS CloudTrail, GitHub audit logs).
3. **Execution timeouts**: TruffleHog execution timeout is hardcoded to 60 seconds without environment configuration, causing large file scans or slow network responses to fail unpredictably without operator control or clear timeout diagnostic messages.

## Solution

Provide operator controls in `.env` and `AppConfig` for TruffleHog execution:
- `TRUFFLEHOG_VERIFICATION_MODE`: Choose between `"all"` (default), `"verified-only"`, and `"no-verification"`.
- `TRUFFLEHOG_USER_AGENT_SUFFIX`: Custom string appended to TruffleHog verification requests via `--user-agent-suffix`.
- `TRUFFLEHOG_TIMEOUT_SECONDS`: Subprocess timeout in seconds (default `60`), triggering clear timeout diagnostics on failure.

All settings are optional in `.env` with safe, backward-compatible defaults matching existing behavior.

## User Stories

1. As a security engineer scanning internal code offline, I want to set `TRUFFLEHOG_VERIFICATION_MODE=no-verification` in `.env`, so that TruffleHog skips live API calls and produces results rapidly without external network access.
2. As a security operator reviewing large finding backlogs, I want to set `TRUFFLEHOG_VERIFICATION_MODE=verified-only` in `.env`, so that TruffleHog filters out all unverified findings and only reports active, live credentials.
3. As a standard operator, I want `TRUFFLEHOG_VERIFICATION_MODE` to default to `all`, so that the default experience performs full live verification and distinguishes verified and unverified secrets.
4. As a cloud security administrator, I want to specify `TRUFFLEHOG_USER_AGENT_SUFFIX=SecurityTeamAudit-2026`, so that all verification requests from TruffleHog can be attributed in target service access logs.
5. As an operator running against repositories with large single files, I want to configure `TRUFFLEHOG_TIMEOUT_SECONDS=120` in `.env`, so that TruffleHog is given sufficient time to complete scanning before timing out.
6. As an operator whose scan times out, I want the error message to state `TruffleHog process timed out after 60s`, so that I immediately understand why the finding failed and can adjust the timeout or retry.
7. As an engineer running existing workflows with an existing `.env` file, I want the system to load cleanly without requiring these new variables to be set, so that existing setups do not break.
8. As a developer running in `hybrid` flow, I want verification mode, user-agent suffix, and timeout settings to apply consistently when TruffleHog is triggered after LLM classification.
9. As a developer running in `trufflehog-only` flow, I want verification mode, user-agent suffix, and timeout settings to apply to every file work item scanned by TruffleHog.
10. As an operator resuming a failed run with `--retry-failed`, I want timeout-failed findings to be re-attempted with updated timeout settings.

## Implementation Decisions

- **Configuration Schema & Types**:
  - Add `TRUFFLEHOG_VERIFICATION_MODE`: Optional Zod enum `["all", "verified-only", "no-verification"]` defaulting to `"all"`.
  - Add `TRUFFLEHOG_TIMEOUT_SECONDS`: Optional integer `>= 1` defaulting to `60`.
  - Add `TRUFFLEHOG_USER_AGENT_SUFFIX`: Optional string, transformed to trimmed string or `undefined`.
  - Extend `AppConfig` type with `trufflehogVerificationMode`, `trufflehogTimeoutSeconds`, and `trufflehogUserAgentSuffix`.

- **TruffleHog CLI Execution**:
  - Define `TruffleHogVerificationMode = "all" | "verified-only" | "no-verification"`.
  - Extend `RunTruffleHogOptions` with `verificationMode?: TruffleHogVerificationMode`, `userAgentSuffix?: string`, and `timeoutMs?: number`.
  - Dynamically construct CLI args:
    - If `verificationMode === "verified-only"`, append `--only-verified`.
    - If `verificationMode === "no-verification"`, append `--no-verification`.
    - If `userAgentSuffix` is provided and non-empty, append `--user-agent-suffix=${userAgentSuffix}`.
  - Subprocess timeout: Pass `timeoutMs = (config.trufflehogTimeoutSeconds ?? 60) * 1000` to the executor. Catch timeout exceptions and format clear error: `TruffleHog process timed out after ${seconds}s`.

- **Status & Outcome Alignment**:
  - Preserve `TruffleHogResult = "verified" | "unverified" | "not_found" | ""`.
  - In `verified-only` mode: findings matching unverified secrets are dropped by TruffleHog and marked as `trufflehog_result="not_found"`.
  - In `no-verification` mode: findings matching detected secrets have `verified=false` and are marked as `trufflehog_result="unverified"`.
  - In `all` mode: findings reflect `verified`, `unverified`, or `not_found`.

- **Hybrid Flow & Pipeline Wiring**:
  - Pass `trufflehogOptions` from `AppConfig` through `PipelineOptions` to `scanWithTruffleHog` and `executeHybridFlow`.

- **Documentation**:
  - Update `.env.example`, `secret-reconciler/README.md`, and top-level `README.md` with descriptions and usage examples of the new variables.

## Testing Decisions

- **What makes a good test**: Tests should verify observable behavior through existing execution seams (config validation output, CLI argument passing to the executor function, timeout error messages, and output CSV results). Tests should not rely on external network calls or require a globally installed `trufflehog` binary.
- **Modules to be tested**:
  - `config.test.ts`: Default fallbacks, valid enum values, valid integer timeouts, trimming of user-agent suffixes, and validation errors for invalid inputs.
  - `trufflehog.test.ts`: CLI argument construction for verification modes, user-agent suffix formatting, and timeout error generation.
  - `hybrid-state-machine.test.ts` & `integration-hybrid.test.ts`: Propagation of TruffleHog options when TruffleHog is invoked in hybrid flow.
- **Prior Art**:
  - `src/__tests__/config.test.ts` for Zod environment variable parsing tests.
  - `src/__tests__/trufflehog.test.ts` for mock executor argument assertions.
  - `src/__tests__/integration-hybrid.test.ts` for end-to-end flow assertions.

## Out of Scope

- Modifying TruffleHog custom detector configurations or detector-specific flags.
- Adding interactive CLI prompt flags for TruffleHog settings (purely `.env` driven).
- Changing CSV output column headers or introducing new schema columns beyond the existing contract.

## Further Notes

- TruffleHog appends `--user-agent-suffix` to its standard `TruffleHog` user-agent header.
- In `no-verification` mode, detectors that rely exclusively on active validation will report unverified or might not produce a match if the detector has no offline pattern.
