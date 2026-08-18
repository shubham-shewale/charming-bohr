/**
 * The SCM provider that hosted the source code.
 */
export type ScmProvider = "github" | "azure";

/**
 * The analysis flow applied to findings.
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
  /** Project name (Azure DevOps only). */
  project?: string;
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

/**
 * Processing status of a finding in the pipeline.
 * @see CONTEXT.md — Status
 */
export type FindingStatus = "completed" | "failed" | "skipped" | "pending";

/**
 * Verification mode for TruffleHog scanning.
 * - "all": Performs live API verification and outputs both verified and unverified findings.
 * - "no-verification": Disables network calls and reports all detections as unverified.
 */
export type TruffleHogVerificationMode = "all" | "no-verification";

/**
 * Lossless verification state reported for an individual TruffleHog detection.
 * `unknown` means verification was attempted but could not complete because of
 * an operational error (for example, a network or upstream API failure).
 */
export type TruffleHogDetectionStatus = "verified" | "unverified" | "unknown";

/**
 * Result outcome of running TruffleHog analysis on a finding's line range.
 * @see CONTEXT.md — TruffleHog Result
 */
export type TruffleHogResult =
  | TruffleHogDetectionStatus
  | "not_detected"
  | "ambiguous"
  | "";

/**
 * A normalized finding referenced from an input CSV row.
 * @see CONTEXT.md — Finding
 */
export interface FindingRef {
  /** 0-based index of the finding row within its input CSV file. */
  rowIndex: number;
  /** Name or path of the source CSV file this finding originated from. */
  sourceFile: string;
  /** Policy or rule identifier if present in the input CSV (e.g. CKV_SECRET_6). */
  checkId?: string;
  /** Map of column header to string value representing the original CSV row verbatim. */
  rawRow: Record<string, string>;
  /** The parsed SCM canonical source, if parsing succeeded. */
  canonicalSource?: CanonicalSource;
  /** Parse error details if SCM link parsing failed. */
  parseError?: ParseError;
  /** Initial processing status computed when reading the CSV row. */
  initialStatus: FindingStatus;
}

/**
 * Unit of work representing one unique Content Identity and all findings associated with it.
 * @see CONTEXT.md — File Work Item
 */
export interface FileWorkItem {
  /** Unique key: provider::org/repo::revision::filePath or provider::org/project/repo::revision::filePath */
  contentIdentity: string;
  provider: ScmProvider;
  org: string;
  project?: string;
  repo: string;
  revision: string;
  filePath: string;
  findings: FindingRef[];
}

/**
 * A single secret detection extracted from TruffleHog filesystem JSON output.
 */
export interface TruffleHogDetection {
  detectorName: string;
  verificationStatus: TruffleHogDetectionStatus;
  /** 1-based source line. Missing when TruffleHog did not provide safe location metadata. */
  lineStart?: number;
  /** 1-based source line. Missing when TruffleHog did not provide safe location metadata. */
  lineEnd?: number;
}

/**
 * Three-valued classification result of LLM analysis on a finding.
 * @see CONTEXT.md — LLM Classification
 */
export type ContextualClassification =
  | "probable_secret"
  | "probable_false_positive"
  | "uncertain";

/** Legacy values remain readable so older output CSVs can still be resumed. */
export type LlmClassification =
  | ContextualClassification
  | "false_positive"
  | "likely_secret";

export type FileRole =
  | "production_configuration"
  | "infrastructure_as_code"
  | "deployment_manifest"
  | "application_code"
  | "test_fixture"
  | "documentation"
  | "example"
  | "generated_file"
  | "unknown";

export type EnvironmentScope =
  | "production"
  | "staging"
  | "development"
  | "test"
  | "unknown";

export type ExposureScope =
  | "internet_facing"
  | "internal"
  | "restricted"
  | "local_only"
  | "unknown";

export type PrincipalScope =
  | "human_user"
  | "service_account"
  | "application"
  | "workload"
  | "shared_account"
  | "unknown";

export type SecretKind =
  | "cloud_credential"
  | "database_credential"
  | "api_token"
  | "private_key"
  | "password"
  | "connection_string"
  | "certificate"
  | "unknown";

export interface ContextEvidence {
  source: "path" | "content" | "metadata";
  description: string;
  line?: number;
}

export interface SecretContextAssessment {
  classification: ContextualClassification;
  fileRole: FileRole;
  environment: EnvironmentScope;
  exposureScope: ExposureScope;
  principalScope: PrincipalScope;
  secretKind: SecretKind;
  evidenceStrength: "strong" | "moderate" | "weak";
  confidence: number;
  evidence: ContextEvidence[];
  benignSignals: string[];
  riskSignals: string[];
  missingEvidence: string[];
  reason: string;
}

export type DetectorGapStatus =
  | "new_detector_candidate"
  | "existing_detector_tuning"
  | "custom_verifier_candidate"
  | "not_a_detector_gap"
  | "uncertain";

export interface DetectorGapAssessment {
  status: DetectorGapStatus;
  proposedName?: string;
  keywords: string[];
  secretShape?: string;
  regexTemplate?: string;
  verificationApproach?: string;
  exclusionSuggestions: string[];
  evidence: string[];
  reason: string;
}

/**
 * Final processing result for a finding row, to be written to the output CSV.
 */
export interface FindingResult {
  findingRef: FindingRef;
  status: FindingStatus;
  trufflehogResult?: TruffleHogResult;
  trufflehogDetector?: string;
  llmClassification?: LlmClassification;
  llmReason?: string;
  llmConfidence?: number;
  contextAssessment?: SecretContextAssessment;
  detectorGapAssessment?: DetectorGapAssessment;
  llmModel?: string;
  llmPromptVersion?: string;
  error?: string;
}
