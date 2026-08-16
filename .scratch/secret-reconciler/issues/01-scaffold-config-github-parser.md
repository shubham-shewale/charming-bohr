# 01 — Project scaffold + config + GitHub SCM parser

**What to build:** A runnable CLI entry point that accepts a CSV path argument, loads `.env` configuration, validates it with Zod (failing early with clear errors for invalid values), and parses GitHub SCM links into `CanonicalSource` objects. The CLI prints parsed results to stdout — not useful as a product yet, but proves the foundation: argument parsing, config validation, the `CanonicalSource` data model, and GitHub URL parsing.

The GitHub SCM link parser extracts provider, org, repo, commit SHA (from the `/blob/{sha}/` segment), file path, and line range (from the `#L{start}-L{end}` fragment). Unparseable links produce a structured error rather than a crash.

Config schema validates: `FLOW` (enum), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `MAX_TOKENS_PER_REQUEST`, `MAX_LLM_CALLS_PER_FILE`, `GITHUB_PAT`, `AZURE_DEVOPS_PAT`, `CONCURRENCY`, `MAX_FILE_SIZE_KB`, `SURROUNDING_LINES`, `CLEANUP_TEMP_FILES`.

Project setup: TypeScript, ESM, npm, Vitest, Node 20+.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] `npm init` project with TypeScript, ESM, Vitest, Node 20+
- [x] CLI entry point accepts one or more CSV path arguments, `--output`, `--retry-failed`, `--keep-files`
- [x] `.env` loaded and Zod-validated at startup; invalid config fails with actionable error message before touching input
- [x] GitHub SCM link parser: extracts provider, org, repo, revision, filePath, lineStart, lineEnd from `https://github.com/{org}/{repo}/blob/{sha}/{path}#L{start}-L{end}`
- [x] `CanonicalSource` type defined and used as the parsed output
- [x] Parser returns structured error for malformed URLs (missing revision, missing line numbers, unrecognised host)
- [x] Unit tests for GitHub parser: valid URLs, URL-encoded paths, missing fragment, missing revision, non-GitHub URLs
- [x] Unit tests for config validation: valid config, missing required fields, invalid enum, negative numbers
