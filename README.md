# Secret Findings Reconciliation

> A high-throughput reconciliation engine and CLI tool that processes large CSV finding reports, verifies potential credentials with TruffleHog, and performs guarded contextual classification through a self-hosted AI Gateway.

---

## Overview

Security scanners (such as GitHub Secret Scanning, Azure DevOps Advanced Security, or external pipeline scanners) often produce hundreds or thousands of raw findings in CSV exports. Many findings point to the same repository and commit revision, while others are false positives (placeholders, documentation examples, expired tokens, or test fixtures).

This repository provides an automated reconciliation tool that:
1. **Parses SCM Links** directly to extract exact commit revisions, repository identities, and line numbers.
2. **Deduplicates Network Fetches** by grouping findings into unique **Content Identities** (one fetch per unique file revision, regardless of finding count).
3. **Classifies Potential Secrets** across three flexible analysis flows:
   - **`trufflehog-only`**: High-speed, local verification via the TruffleHog CLI scanner.
   - **`llm-only`**: Guarded semantic context analysis through the configured AI Gateway.
   - **`hybrid`**: Verification-first dual-stage pipeline (TruffleHog first; LLM false-positive analysis only for unverified or not-detected findings).
4. **Fine-Grained TruffleHog Execution Controls**:
   - Pinned TruffleHog `3.97.0` runtime contract with startup validation.
   - `TRUFFLEHOG_VERIFICATION_MODE`: Choose between `"all"` (default) and `"no-verification"` (for rapid offline scanning).
   - `TRUFFLEHOG_CONFIG_PATH`: Load custom detector and verifier definitions from YAML.
   - `TRUFFLEHOG_USER_AGENT_SUFFIX`: Custom audit identifier appended to scanner requests for log attribution.
   - `TRUFFLEHOG_TIMEOUT_SECONDS`: Operator-configured subprocess timeout with clear diagnostic reporting.
5. **Supports Resumable & Incremental Execution** by treating the output CSV as valid input, auto-skipping completed rows, and supporting selective failure retries.

---

## Domain Model & Core Vocabulary

All modules, CLI flags, output columns, and logs strictly adhere to the domain language defined in [`CONTEXT.md`](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/CONTEXT.md):

| Term | Definition |
| :--- | :--- |
| **Finding** | A single row in the input CSV representing a potential secret detected by a scanner. |
| **SCM Link** | The direct blob/commit URL in the input CSV (GitHub or Azure DevOps). Primary source of truth for file path, revision, and line numbers. |
| **Canonical Source** | The normalized representation of an SCM link (`provider`, `org`, `repo`, `revision`, `filePath`, `lineStart`, `lineEnd`). |
| **Content Identity** | The unique tuple determining file content (`provider + org/repo + revision + filePath`). Used to fetch a file exactly once. |
| **File Work Item** | A batch unit: one unique Content Identity paired with all findings referencing that file. |
| **Flow** | The classification strategy: `trufflehog-only`, `llm-only`, or `hybrid`. |
| **Status** | The processing state in the output CSV: `completed`, `failed`, `skipped`, or `pending`. |
| **LLM Classification** | Contextual plausibility: `probable_false_positive`, `probable_secret`, or `uncertain`; it never represents credential validity. |
| **TruffleHog Result** | The lossless scanner outcome: `verified`, `unverified`, `unknown`, `not_detected`, or `ambiguous`. |

---

## Repository Structure

```
.
├── CONTEXT.md                  # Strict domain model and ubiquitous language definitions
├── docs/
│   └── adr/                    # Architecture Decision Records
│       ├── 0001-scm-link-as-primary-source.md   # Single source of truth for identity
│       └── 0002-output-as-input-resume.md        # Resumable output-as-input workflow
├── secret-reconciler/          # The TypeScript CLI reconciliation tool
│   ├── src/
│   │   ├── csv/                # Streaming CSV parser and atomic writer
│   │   ├── fetcher/            # Rate-limited, cached file fetcher
│   │   ├── hybrid/             # Hybrid flow state machine
│   │   ├── ai-gateway/         # Provider-neutral self-hosted gateway adapter
│   │   ├── llm/                # Redaction, evidence policy, prompts, tools, and contextual analysis
│   │   ├── parsers/            # GitHub and Azure DevOps SCM URL parsers
│   │   ├── providers/          # SCM REST API clients (GitHub & Azure DevOps)
│   │   ├── trufflehog/         # TruffleHog CLI runner and line matcher
│   │   ├── config.ts           # Zod-validated environment configuration
│   │   ├── pipeline.ts         # Orchestration pipeline and progress emitter
│   │   └── index.ts            # Commander.js CLI entrypoint
│   ├── package.json
│   └── README.md               # Detailed CLI guide, setup, flags, and schemas
└── LICENSE
```

---

## Architecture Decision Records (ADRs)

Key architectural choices are formally documented in [`docs/adr/`](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/docs/adr/):

- **[ADR 0001: SCM Link as Primary Source of Truth](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/docs/adr/0001-scm-link-as-primary-source.md)**  
  Rather than relying on loosely structured CSV columns (`repository`, `file path`), the tool parses the SCM link URL directly. This guarantees exact 40-character commit revisions, line numbers, and multi-provider detection.
- **[ADR 0002: Resume by Re-Feeding Output CSV as Input](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/docs/adr/0002-output-as-input-resume.md)**  
  Eliminates state databases or sidecar progress files. The output CSV contains all original columns plus reconciled results and can be directly passed back into the CLI to resume interrupted jobs or retry failed rows.

---

## Getting Started

To install, configure, and run the reconciler CLI, refer to the complete guide:

👉 **[Go to Secret Reconciler CLI Documentation](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/secret-reconciler/README.md)**

```bash
# Quick navigation
cd secret-reconciler
npm install
cp .env.example .env
npm run dev -- ../path/to/findings.csv
```

---

## Development & Testing

From the `secret-reconciler/` directory:

```bash
# Run unit & integration tests (Vitest)
npm test

# Watch mode for development
npm run test:watch

# Static type checking (TypeScript)
npm run typecheck
```

---

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](file:///Users/shubhamshewale/Documents/antigravity/charming-bohr/LICENSE) file for details.
