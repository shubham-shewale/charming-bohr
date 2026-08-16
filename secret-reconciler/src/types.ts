/**
 * The SCM provider that hosted the source code.
 */
export type ScmProvider = "github" | "azure-devops";

/**
 * The analysis strategy applied to findings.
 * @see CONTEXT.md — Flow
 */
export type Flow = "trufflehog-only" | "llm-only" | "hybrid";

/**
 * The parsed, normalized representation of an SCM link.
 *
 * Contains everything needed to uniquely identify a file at a specific commit
 * and the line range of interest. This is the single source of truth for
 * all identity, grouping, and fetching decisions.
 *
 * @see ADR 0001 — SCM link as primary source of truth
 */
export interface CanonicalSource {
  provider: ScmProvider;
  /** Organisation or account that owns the repository. */
  org: string;
  /** Repository name (without the org prefix). */
  repo: string;
  /** Full 40-character commit SHA. */
  revision: string;
  /** URL-decoded file path relative to the repository root. */
  filePath: string;
  /** 1-based start line of the finding. */
  lineStart: number;
  /** 1-based end line of the finding. Equals lineStart for single-line findings. */
  lineEnd: number;
}

/**
 * A structured error returned when an SCM link cannot be parsed into a
 * CanonicalSource. Never throws — always returns a discriminated union.
 */
export interface ParseError {
  /** Machine-readable error category. */
  kind:
    | "unsupported-host"
    | "not-a-blob-url"
    | "missing-revision"
    | "missing-line-numbers";
  /** Human-readable explanation of what was wrong. */
  message: string;
  /** The original URL that failed to parse. */
  rawUrl: string;
}

/**
 * The result of attempting to parse an SCM link.
 * Use `result.ok` to discriminate between success and failure.
 */
export type ScmParseResult =
  | { ok: true; value: CanonicalSource }
  | { ok: false; error: ParseError };
