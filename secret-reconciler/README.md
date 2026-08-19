# Secret Reconciler (`secret-reconciler`)

> A high-throughput CLI that verifies potential credentials with TruffleHog and adds guarded contextual classification through a self-hosted AI Gateway.

---

## Table of Contents

- [Features](#features)
- [Architecture & Workflow](#architecture--workflow)
- [Prerequisites & Tool Setup](#prerequisites--tool-setup)
- [Installation & Quickstart](#installation--quickstart)
- [Environment Configuration](#environment-configuration)
- [Analysis Flows](#analysis-flows)
- [CLI Reference & Usage](#cli-reference--usage)
- [CSV Schemas](#csv-schemas)
  - [Input SCM Link Formats](#input-scm-link-formats)
  - [Output Columns & Values](#output-columns--values)
- [Operational Resilience & Edge Cases](#operational-resilience--edge-cases)
- [Development & Testing](#development--testing)

---

## Features

- ⚡ **Deduplicated Fetching via Content Identity**: Groups hundreds of findings across the same repository and commit SHA into single **File Work Items**, fetching each file only once.
- 🌐 **Multi-Provider SCM Support**: Direct REST API integration for both **GitHub** and **Azure DevOps** with exact 40-character commit revision pinning.
- 🧠 **Three Analysis Flows**:
  - `trufflehog-only`: High-speed local verification via TruffleHog CLI.
  - `llm-only`: Guarded semantic context analysis through the configured AI Gateway.
  - `hybrid`: Verification first; only `unverified` or `not_detected` findings receive contextual analysis.
- 🧭 **Context Dimensions**: Records file role, environment, exposure, principal scope, secret kind, evidence strength, and cited evidence without claiming credential validity.
- 🧩 **Detector Gap Advice**: Optionally proposes review-only custom detector candidates for `not_detected + probable_secret` outcomes.
- 🔒 **Gateway Guardrails**: Redacts suspected values, uses forced schema-validated tool calls, caps path-only confidence, and restricts context expansion to the same fetched file.
- 🔄 **Output-as-Input Resume**: Directly re-feed an output CSV to resume interrupted jobs or retry failed rows without separate checkpoint files.
- 🛡️ **Graceful Cancellation**: Intercepts `SIGINT` / `SIGTERM` signals to finish in-flight requests and flush an uncorrupted CSV before exiting.
- 💰 **Concise Usage Tracking**: Throttled progress shows gateway-reported input, output, and cached-input tokens plus configured cost estimates without printing one line per record.

---

## Architecture & Workflow

### 1. Pipeline Lifecycle

```mermaid
flowchart TD
    A[Input CSV Findings] --> B[Read CSV & Parse SCM Links]
    B --> C[Group by Content Identity]
    
    subgraph WorkItemProcessing [File Work Item Processing]
        C --> G{Flow Strategy}
        G -- trufflehog-only --> F1[Fetch File] --> H[Run TruffleHog Scanner]
        G -- llm-only --> P{Path Eligible?}
        P -- No --> E[Mark LLM-only Finding Skipped]
        P -- Yes --> F2[Fetch File] --> D{Size Eligible?}
        D -- No --> E
        D -- Yes --> I[Run AI Gateway Context Analysis]
        G -- hybrid --> F3[Fetch File] --> J[Run TruffleHog, Then Gate LLM Fallback]
    end
    
    H --> K[Merge & Build Results]
    I --> K
    J --> K
    E --> K
    
    K --> L[Atomic Write to Output CSV]
```

### 2. Hybrid Flow State Machine

In `hybrid` flow, TruffleHog owns credential detection and validity. Verified, verifier-error (`unknown`), and unsafe-correlation (`ambiguous`) results are terminal and never sent to the LLM. Only `unverified` and `not_detected` findings reach guarded contextual analysis:

```mermaid
stateDiagram-v2
    [*] --> TruffleHog
    TruffleHog --> Complete_Verified: verified
    TruffleHog --> Manual_Review: unknown / ambiguous
    TruffleHog --> Context_Analysis: unverified / not_detected
    TruffleHog --> Failed: execution error
    Context_Analysis --> Detector_Advice: not_detected + probable_secret
    Context_Analysis --> Complete_With_Both: contextual assessment
    Context_Analysis --> Needs_Review: gateway error / invalid output
    Detector_Advice --> Complete_With_Both: review-only proposal
    Complete_Verified --> [*]
    Manual_Review --> [*]
    Complete_With_Both --> [*]
    Failed --> [*]
    Needs_Review --> [*]
```

---

## Prerequisites & Tool Setup

### 1. Node.js

Requires **Node.js >= 20.0.0**.

```bash
# Verify your Node.js version
node --version

# If needed, install or switch using nvm / fnm
nvm install 20
nvm use 20
```

### 2. TruffleHog CLI

Required for `trufflehog-only` and `hybrid` flows. Version **3.97.0** must be available on your system `PATH`; the CLI checks this contract at startup and fails closed on a different version.

```bash
# Linux / macOS (pinned binary install)
curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh \
  | sudo sh -s -- -b /usr/local/bin v3.97.0

# Must report 3.97.0
trufflehog --version
```

### 3. Credentials & Gateway Access

| Provider | Variable | Required Permissions / Scopes |
| :--- | :--- | :--- |
| **GitHub** | `GITHUB_PAT` | Fine-grained PAT with **Contents: Read-only** on target repos, or Classic PAT with `repo` scope (for private repositories). |
| **Azure DevOps** | `AZURE_DEVOPS_PAT` | Personal Access Token with **Code (Read)** permission. |
| **AI Gateway** | `AI_GATEWAY_AUTH_TOKEN` | Optional bearer token; may be omitted when the self-hosted gateway uses mTLS or workload identity. |

---

## Installation & Quickstart

```bash
# 1. Navigate to the secret-reconciler directory
cd secret-reconciler

# 2. Install dependencies
npm install

# 3. Create your local .env configuration
cp .env.example .env

# 4. Edit .env with your tokens and desired FLOW
nano .env

# 5. Run reconciliation on one or more CSVs
npm run dev -- ../path/to/findings.csv
```

---

## Environment Configuration

Configuration is loaded from `.env` (or ambient environment variables) and strictly validated on startup using **Zod**. If any variable is missing or invalid, the CLI exits immediately with a descriptive error.

| Environment Variable | Type | Default / Example | Required? | Description |
| :--- | :--- | :--- | :--- | :--- |
| `FLOW` | Enum | `hybrid` | **Yes** | Analysis flow: `trufflehog-only`, `llm-only`, or `hybrid`. |
| `AI_GATEWAY_URL` | URL | `https://ai-gateway.internal` | Conditional | Required when contextual classification is enabled. The gateway must expose an OpenAI-compatible `/v1/chat/completions` endpoint. |
| `AI_GATEWAY_MODEL` | String | `security-context-model` | Conditional | Gateway model identifier. |
| `AI_GATEWAY_AUTH_TOKEN` | String | `...` | *Optional* | Bearer token; omit for other gateway authentication mechanisms. |
| `AI_GATEWAY_TIMEOUT_SECONDS` | Integer | `30` | *Optional* | Per-request timeout. |
| `AI_GATEWAY_PROMPT_CACHE_KEY` | String | `secret-reconciler` | *Optional* | Forwarded as `prompt_cache_key` when the gateway/model supports OpenAI-compatible prompt caching. |
| `AI_GATEWAY_PROMPT_CACHE_RETENTION` | Enum | `in_memory`, `24h` | *Optional* | Forwarded retention request. Support depends on the selected gateway/model. |
| `AI_GATEWAY_INPUT_COST_PER_MILLION_USD` | Number | `1.25` | *Optional* | Input-token price for the configured model. Cost is `n/a` unless both input and output prices are set. |
| `AI_GATEWAY_OUTPUT_COST_PER_MILLION_USD` | Number | `10.00` | *Optional* | Output-token price for the configured model. |
| `AI_GATEWAY_CACHED_INPUT_COST_PER_MILLION_USD` | Number | `0.125` | *Optional* | Cached-input price. Defaults to the normal input price when omitted. |
| `LLM_CONTEXT_CLASSIFIER_ENABLED` | Boolean | `true` | *Optional* | When false in Hybrid, unresolved findings become `uncertain` without a gateway request. Cannot be false for `llm-only`. |
| `LLM_DETECTOR_ADVISOR_ENABLED` | Boolean | `false` | *Optional* | Enables review-only detector advice for `not_detected + probable_secret`. |
| `LLM_MAX_CONTEXT_EXPANSIONS` | Integer | `2` | *Optional* | Maximum bounded context tool calls per batch. |
| `LLM_MAX_CONTEXT_LINES` | Integer | `150` | *Optional* | Maximum lines returned by each context tool call. |
| `LLM_IGNORE_PATTERNS` | CSV String | `*.min.js,node_modules/,*.log` | *Optional* | Repository-relative basename, directory, or path globs excluded only from LLM analysis. |
| `LLM_PROMPT_PROFILE` | Enum | `context-classifier-v2` | *Optional* | Versioned classifier prompt. V2 adds bounded current-file search; V1 remains accepted for compatibility. |
| `MAX_TOKENS_PER_REQUEST` | Integer | `4096` | Conditional | Maximum completion tokens per gateway request (>= 1). |
| `MAX_LLM_CALLS_PER_FILE` | Integer | `3` | **Yes** (LLM/Hybrid) | Maximum LLM batch calls per file work item (>= 1). |
| `GITHUB_PAT` | String | `ghp_...` | **Yes** | GitHub Personal Access Token. |
| `AZURE_DEVOPS_PAT` | String | `...` | *Optional* | Azure DevOps Personal Access Token (required if Azure links exist). |
| `TRUFFLEHOG_VERIFICATION_MODE` | Enum | `all` | *Optional* | Verification mode: `all` (default) or `no-verification`. `verified-only` is rejected because it discards evidence. |
| `TRUFFLEHOG_TIMEOUT_SECONDS` | Integer | `60` | *Optional* | Subprocess timeout for TruffleHog scans in seconds (>= 1, default `60`). |
| `TRUFFLEHOG_USER_AGENT_SUFFIX` | String | `...` | *Optional* | Custom suffix appended to TruffleHog outgoing verification HTTP requests. |
| `TRUFFLEHOG_CONFIG_PATH` | String | `/etc/trufflehog/custom.yaml` | *Optional* | YAML configuration containing custom TruffleHog detectors and verifiers. |
| `CHECK_IDS` | String | `CKV_SECRET_6,CKV_AWS_1` | *Optional* | Comma-separated list of Check IDs to reconcile (default: all). |
| `LIMIT` | Integer | `100` | *Optional* | Maximum number of pending findings to process in this run (>= 1, default: unlimited). |
| `CONCURRENCY` | Integer | `5` | **Yes** | Number of file work items processed concurrently (>= 1). |
| `MAX_FILE_SIZE_KB` | Integer | `500` | **Yes** | Maximum file size eligible for LLM analysis (>= 1); TruffleHog scanning is unaffected. |
| `SURROUNDING_LINES` | Integer | `10` | *Optional* | Initial lines of redacted context included above and below each finding. |
| `CLEANUP_TEMP_FILES` | Boolean | `true` | **Yes** | Coerces `"true"` or `"false"`. Deletes downloaded source files on completion. |

---

## Analysis Flows

### LLM Context and Allowed Tools

The initial classifier request contains the repository path and revision, TruffleHog result, file/path signals, finding line range, and a redacted window of 10 lines above and below the finding by default. `LLM_MAX_CONTEXT_LINES` does not control this initial window; it caps a later explicit range read.

The gateway receives only these application-defined tools, in a fixed order:

1. `search_current_file` — literal or restricted line-safe regex search over the already-fetched file; returns at most 20 matches with bounded redacted context.
2. `get_additional_file_context` — reads one redacted line range from the same file, capped by `LLM_MAX_CONTEXT_LINES`.
3. `submit_context_assessments` — submits the final schema-validated classification.

The optional detector-advisor request receives only `submit_detector_gap_assessments`. Tool names returned by the gateway are checked against the request's declared tool list; undeclared tools are rejected. Search and range reads share the `LLM_MAX_CONTEXT_EXPANSIONS` budget and never fetch another repository file.

Prompt caching is performed by the gateway/model, not by this CLI. The CLI keeps system instructions and ordered tool schemas stable before dynamic finding content and can forward a configured cache key and retention policy. Actual cache use is reported only from the gateway's `cached_tokens` value.

| Flow | Strengths | Ideal For | LLM Used? | Scanner Used? |
| :--- | :--- | :--- | :--- | :--- |
| **`hybrid`** *(Recommended)* | Preserves scanner evidence, then classifies context and optionally identifies detector gaps. | Production scans containing mixed alerts. | ✅ (Conditional) | ✅ (Always) |
| **`llm-only`** | Best for understanding complex code context, documentation, mock tests, and template files. | Eliminating false positives where regex scanners trigger on test fixtures. | ✅ | ❌ |
| **`trufflehog-only`** | Ultra-fast, zero API cost, validates live detector endpoints. | Quick verification runs without external LLM dependencies. | ❌ | ✅ |

---

## CLI Reference & Usage

```bash
secret-reconciler [options] <csv...>
```

### Options

| Option | Flag | Description | Default |
| :--- | :--- | :--- | :--- |
| `--output` | `-o <path>` | Custom destination path for the reconciled output CSV. | `results-YYYYMMDDTHHMM.csv` |
| `--check-ids` | `<ids...>` | Filter findings by one or more Check IDs (comma or space separated). | `(all)` |
| `--limit` | `-n <count>` | Limit reconciliation to the first N pending findings. | `(unlimited)` |
| `--retry-failed` | *(boolean)* | Re-process rows previously marked with `status=failed`. | `false` |
| `--keep-files` | *(boolean)* | Prevent deletion of downloaded source files for manual inspection. | `false` |
| `--help` | `-h` | Display help screen and option descriptions. | — |
| `--version` | `-V` | Output version number. | `0.1.0` |

If another run already reserved the default output name in the same minute, the CLI appends a numeric suffix such as `-1` instead of overwriting it.

The terminal displays a single throttled status line in interactive runs and one status snapshot every 30 seconds in non-interactive runs. Token counts come only from the gateway response. Cached input is displayed only when the gateway returns `usage.prompt_tokens_details.cached_tokens`; otherwise it is shown as `n/a`.

### Common Usage Examples

#### 1. Standard Single CSV Reconciliation
```bash
npm run dev -- ./data/github-findings.csv
```

#### 2. Filter by Specific Check IDs
Target only specific detection rules (e.g. `CKV_SECRET_6` or `CKV_AWS_1`), preserving all other rows in `pending` status:
```bash
npm run dev -- ./data/findings.csv --check-ids CKV_SECRET_6 CKV_AWS_1
```

#### 3. Bounded Batch Run (Finding Limit)
Process only the first 50 pending findings to save tokens or test configuration changes:
```bash
npm run dev -- ./data/findings.csv -n 50
```

#### 4. Combined Filter and Limit
Apply Check ID filtering first, then bound to a batch of 100 matching findings:
```bash
npm run dev -- ./data/findings.csv --check-ids CKV_SECRET_6 -n 100 -o ./batch-ckv6.csv
```

#### 5. Multi-CSV Merge Run
Processes multiple scanner exports (e.g. GitHub and Azure DevOps), unifies all columns, and records original filenames in `source_file`:
```bash
npm run dev -- ./data/github-findings.csv ./data/ado-findings.csv -o ./reconciled-all.csv
```

#### 6. Resume an Interrupted Job
If a previous run was stopped or partially processed, simply pass the generated output CSV back as input. Completed rows will be skipped automatically:
```bash
npm run dev -- ./reconciled-all.csv -o ./reconciled-all.csv
```

#### 7. Retry Failed Rows
To re-attempt network errors, API timeouts, or rate limits for failed rows:
```bash
npm run dev -- ./reconciled-all.csv --retry-failed -o ./reconciled-all.csv
```

#### 8. Debugging & File Retention
Retain downloaded files in the operating system temp directory to inspect exact file content:
```bash
npm run dev -- ./data/findings.csv --keep-files
```

#### 6. Offline Scanning (No Network Verification)
Run fast offline scans without making live verification API calls to external third-party services:
```bash
# In .env:
# TRUFFLEHOG_VERIFICATION_MODE=no-verification
npm run dev -- ./data/findings.csv
```

#### 7. Audit Attribution & Timeout Control
Attach a custom audit tracking string to TruffleHog verification requests and give slow scans extra time:
```bash
# In .env:
# TRUFFLEHOG_USER_AGENT_SUFFIX=SecurityAuditTeam-2026
# TRUFFLEHOG_TIMEOUT_SECONDS=120
npm run dev -- ./data/findings.csv
```

---

## CSV Schemas

### Input SCM Link Formats

The reconciler auto-detects the SCM link column by checking header variations: `scmlink`, `scmlinkurl`, `scmurl`, `sourcelink`, `repolink`, `url`, or `link`.

#### Supported URL Patterns

- **GitHub Blob URLs**:
  ```text
  https://github.com/{org}/{repo}/blob/{40-char-commit-sha}/{file-path}#L{start}[-L{end}]
  ```
  *Example*: `https://github.com/octocat/hello-world/blob/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/src/config.json#L12-L14`

- **Azure DevOps Git URLs**:
  ```text
  https://dev.azure.com/{org}/{project}/_git/{repo}?path={filePath}&version=GC{40-char-commit-sha}&line={start}&lineEnd={end}
  ```
  *Example*: `https://dev.azure.com/myorg/myproject/_git/backend-service?path=/secrets/auth.py&version=GCa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2&line=45&lineEnd=47`

> [!NOTE]
> SCM links must reference a full **40-character commit SHA**. Branch references (e.g. `/blob/main/...`) are rejected to avoid scanning the wrong revision.

---

### Output Columns & Values

The output CSV preserves **all original input columns** verbatim and appends 20 reconciliation columns. The contextual fields are evidence, not credential-validity claims:

| Output Column | Type | Example Values | Description |
| :--- | :--- | :--- | :--- |
| `source_file` | String | `github-findings.csv` | Original input CSV file name where the finding originated. |
| `status` | Enum | `completed`, `failed`, `skipped`, `pending` | Final processing status of the finding. |
| `trufflehog_result` | Enum | `verified`, `unverified`, `unknown`, `not_detected`, `ambiguous`, `""` | Lossless TruffleHog outcome for the finding's line range. |
| `trufflehog_detector` | String | `AWS`, `SlackWebhook`, `GenericKey` | TruffleHog detector type if a secret was detected. |
| `llm_classification` | Enum | `probable_false_positive`, `probable_secret`, `uncertain` | Contextual plausibility, independent of live verification. |
| `llm_reason` | String | `"Variable is a mock test token in fixture"` | Brief explanation generated by the LLM. |
| `llm_confidence` | Float | `0.95` | Confidence score between `0.0` and `1.0`. |
| `llm_evidence_strength` | Enum | `weak`, `moderate`, `strong` | Deterministically constrained evidence tier. |
| `llm_file_role` | Enum | `deployment_manifest`, `test_fixture`, `unknown` | Inferred role of the file. |
| `llm_environment` | Enum | `production`, `test`, `unknown` | Inferred environment with evidence. |
| `llm_exposure_scope` | Enum | `internet_facing`, `internal`, `unknown` | Exposure inference; path-only claims are rejected. |
| `llm_principal_scope` | Enum | `service_account`, `workload`, `unknown` | Likely principal type. |
| `llm_secret_kind` | Enum | `database_credential`, `api_token`, `unknown` | Likely secret category. |
| `llm_evidence` | JSON | `{...}` | Cited evidence, benign/risk signals, and missing evidence. |
| `detector_gap_status` | Enum | `new_detector_candidate`, `uncertain`, `""` | Review-only gap assessment. |
| `detector_gap_reason` | String | `"Scanner did not detect the generalized token shape"` | Detector proposal rationale. |
| `detector_gap_proposal` | JSON | `{...}` | Generalized proposal; never applied automatically. |
| `llm_model` | String | `security-context-model` | Audited gateway model. |
| `llm_prompt_version` | String | `context-classifier-v2` | Versioned prompt/tool contract. |
| `error` | String | `""`, `File size (650 KB) exceeds limit` | Error or skip reason if not completed. |

#### Status & Classification Value Dictionary

- **`status`**:
  - `completed`: Successfully analyzed by the configured flow.
  - `failed`: Network fetch failed, scanner error, or another unrecoverable processing error. Gateway failures become completed `uncertain` review outcomes.
  - `skipped`: Unparseable SCM URL, or an `llm-only` file was excluded by size/path policy.
  - `pending`: Unfinished row from an interrupted run.
- **`trufflehog_result`**:
  - `verified`: Secret was confirmed active/live by TruffleHog detector.
  - `unverified`: Secret signature matched, but was not verified as active (or verification was disabled).
  - `unknown`: Verification was attempted but could not complete because of an operational error.
  - `not_detected`: Scanner completed and no detection overlapped the specified lines.
  - `ambiguous`: Detection evidence exists, but missing or overlapping location metadata prevents a safe one-to-one match.
- **`llm_classification`**:
  - `probable_false_positive`: Context resembles a placeholder, test fixture, example, or non-secret reference.
  - `probable_secret`: Context suggests genuine or historical credential material, without claiming it is active.
  - `uncertain`: Evidence is insufficient or conflicting.

---

## Operational Resilience & Edge Cases

### 1. Graceful Shutdown (`SIGINT` / `SIGTERM`)
When you press `Ctrl+C`:
- **Single Press**: The CLI immediately stops dequeuing new files, gives active in-flight work a short grace period, then cancels it if necessary. Completed work is flushed to the output CSV, unfinished rows remain `status=pending`, and the process exits with code `130`.
- **Double Press**: Forces immediate process exit.

### 2. Atomic Writes
Output files are written using a unique temporary sibling file (`<output>.tmp.<pid>.<uuid>`) and atomically renamed to prevent file corruption during sudden terminations.

### 3. File Size Caps (`MAX_FILE_SIZE_KB`)
Files exceeding `MAX_FILE_SIZE_KB` (default 500 KB) are not sent to the LLM. In `llm-only` mode they are marked `status=skipped`; in `hybrid` mode TruffleHog still scans them and its result is preserved with an LLM policy-skip reason.

`LLM_IGNORE_PATTERNS` applies the same LLM-only exclusion to repository-relative paths. Basename globs such as `*.log` and `*.min.js` match at any depth, directory patterns such as `node_modules/` match complete path segments, and path globs such as `generated/**` are also supported. These patterns never disable TruffleHog scanning.

### 4. Large Finding Batching
Files with more than 15 findings are automatically partitioned into batches of 15. The CLI enforces `MAX_LLM_CALLS_PER_FILE` to safeguard against runaway API calls on heavily flagged files.

---

## Development & Testing

### Running the Test Suite

The test suite uses [Vitest](https://vitest.dev/) with 100% unit and integration test coverage across all parsers, fetchers, CSV reader/writers, and flow state machines.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test suite
npm test -- src/__tests__/integration-hybrid.test.ts

# TypeScript typechecking
npm run typecheck

# Exercise the adapter against the real pinned TruffleHog binary
npm run test:trufflehog-contract
```

### Module Overview

- `src/parsers/`: Discriminated union URL parsers for GitHub and Azure DevOps SCM links.
- `src/fetcher/`: Multi-provider file downloader with concurrency control and size checks.
- `src/ai-gateway/`: Provider-neutral OpenAI-compatible self-hosted gateway adapter.
- `src/llm/`: Redaction, context assembly, evidence policy, prompts, constrained tools, contextual classification, and detector advice.
- `src/trufflehog/`: Filesystem scanner executor and line-overlap matching algorithms.
- `src/hybrid/`: Pure transition function state machine governing Hybrid flow execution.
- `src/csv/`: Streaming CSV reader with fuzzy header discovery and atomic CSV writer.
- `src/pipeline.ts`: Central orchestration pipeline.
- `src/index.ts`: Commander.js CLI entrypoint.
