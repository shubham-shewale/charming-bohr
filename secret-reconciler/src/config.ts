import { z } from "zod";
import dotenv from "dotenv";
import type { Flow, TruffleHogVerificationMode } from "./types.js";


// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * Coerces a string "true"/"false" to a boolean.
 * Rejects any other value with a clear error message.
 */
const booleanString = z
  .string()
  .transform((val, ctx) => {
    if (val === "true") return true;
    if (val === "false") return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Expected "true" or "false" but got "${val}".`,
    });
    return z.NEVER;
  });

/**
 * Coerces a string to an integer >= min. Returns a Zod error for anything
 * below the bound or non-integer values.
 */
function rangedIntString(min: number) {
  const label = min === 0 ? "non-negative integer (>= 0)" : `positive integer (>= ${min})`;
  return z.string().transform((val, ctx) => {
    const n = Number(val);
    if (!Number.isInteger(n) || n < min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a ${label} but got "${val}".`,
      });
      return z.NEVER;
    }
    return n;
  });
}

/**
 * Optional string transformer that trims whitespace and returns undefined if empty.
 */
const optionalTrimmedString = z
  .string()
  .optional()
  .transform((val) => {
    if (!val || val.trim().length === 0) return undefined;
    return val.trim();
  });

/**
 * Coerces an optional string to an integer >= min, falling back to defaultValue when omitted or empty.
 */
function optionalRangedIntString(min: number, defaultValue: number) {
  const label = min === 0 ? "non-negative integer (>= 0)" : `positive integer (>= ${min})`;
  return z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === "") return defaultValue;
      const n = Number(val);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected a ${label} but got "${val}".`,
        });
        return z.NEVER;
      }
      return n;
    });
}


/**
 * Optional string transformer that trims whitespace, splits by comma, and returns undefined if empty.
 */
const optionalCheckIds = z
  .string()
  .optional()
  .transform((val) => {
    if (val === undefined || val.trim().length === 0) return undefined;
    const tokens = val
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return tokens.length > 0 ? tokens : undefined;
  });

/**
 * Coerces an optional string to a positive integer (>= 1), returning undefined when omitted or empty.
 */
const optionalPositiveInt = z
  .string()
  .optional()
  .transform((val, ctx) => {
    if (val === undefined || val.trim() === "") return undefined;
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a positive integer (>= 1) but got "${val}".`,
      });
      return z.NEVER;
    }
    return n;
  });

const configSchema = z.object({
  FLOW: z.enum(["trufflehog-only", "llm-only", "hybrid"] as const, {
    errorMap: () => ({
      message: `Must be one of: "trufflehog-only", "llm-only", "hybrid".`,
    }),
  }),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY must not be empty."),
  ANTHROPIC_MODEL: z.string().min(1, "ANTHROPIC_MODEL must not be empty."),
  MAX_TOKENS_PER_REQUEST: rangedIntString(1),
  MAX_LLM_CALLS_PER_FILE: rangedIntString(1),
  GITHUB_PAT: z
    .string()
    .min(1, "GITHUB_PAT must not be empty.")
    .transform((val, ctx) => {
      const tokens = val
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tokens.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GITHUB_PAT must contain at least one non-empty token.",
        });
        return z.NEVER;
      }
      return tokens;
    }),
  GITHUB_RATE_LIMIT_MAX_RETRIES: optionalRangedIntString(0, 2),
  AZURE_DEVOPS_PAT: optionalTrimmedString,
  CONCURRENCY: rangedIntString(1),
  MAX_FILE_SIZE_KB: rangedIntString(1),
  SURROUNDING_LINES: rangedIntString(0),
  CLEANUP_TEMP_FILES: booleanString,
  TRUFFLEHOG_VERIFICATION_MODE: z
    .enum(["all", "verified-only", "no-verification"] as const, {
      errorMap: () => ({
        message: `Must be one of: "all", "verified-only", "no-verification".`,
      }),
    })
    .optional()
    .default("all"),
  TRUFFLEHOG_TIMEOUT_SECONDS: optionalRangedIntString(1, 60),
  TRUFFLEHOG_USER_AGENT_SUFFIX: optionalTrimmedString,
  CHECK_IDS: optionalCheckIds,
  LIMIT: optionalPositiveInt,
});


// ---------------------------------------------------------------------------
// Parsed config type
// ---------------------------------------------------------------------------

/**
 * Validated, camelCased application configuration.
 * Use {@link loadConfig} to obtain an instance.
 */
export interface AppConfig {
  flow: Flow;
  anthropicApiKey: string;
  anthropicModel: string;
  maxTokensPerRequest: number;
  maxLlmCallsPerFile: number;
  /** One or more GitHub PATs parsed from the comma-separated GITHUB_PAT env var. */
  githubPats: string[];
  azureDevOpsPat?: string;
  concurrency: number;
  maxFileSizeKb: number;
  surroundingLines: number;
  cleanupTempFiles: boolean;
  trufflehogVerificationMode: TruffleHogVerificationMode;
  trufflehogTimeoutSeconds: number;
  trufflehogUserAgentSuffix?: string;
  /** Maximum number of defer-and-retry passes when the GitHub rate limit is hit. Default 2. */
  githubRateLimitMaxRetries: number;
  /** Optional filter to restrict reconciliation to specific Check IDs. */
  checkIds?: string[];
  /** Optional limit on the number of pending findings to process. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Loads `.env` (if present) then validates `process.env` against the config
 * schema. Throws a descriptive {@link ConfigError} listing ALL invalid fields
 * if validation fails — never partially valid.
 *
 * Call once at startup before any other work begins.
 */
export function loadConfig(): AppConfig {
  dotenv.config(); // no-op if .env doesn't exist

  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const field = issue.path.join(".") || "(unknown field)";
      return `  • ${field}: ${issue.message}`;
    });
    throw new ConfigError(
      `Invalid configuration. Fix the following environment variables:\n\n${lines.join("\n")}\n`
    );
  }

  const env = result.data;

  return {
    flow: env.FLOW,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.ANTHROPIC_MODEL,
    maxTokensPerRequest: env.MAX_TOKENS_PER_REQUEST,
    maxLlmCallsPerFile: env.MAX_LLM_CALLS_PER_FILE,
    githubPats: env.GITHUB_PAT,
    azureDevOpsPat: env.AZURE_DEVOPS_PAT,
    concurrency: env.CONCURRENCY,
    maxFileSizeKb: env.MAX_FILE_SIZE_KB,
    surroundingLines: env.SURROUNDING_LINES,
    cleanupTempFiles: env.CLEANUP_TEMP_FILES,
    trufflehogVerificationMode: env.TRUFFLEHOG_VERIFICATION_MODE,
    trufflehogTimeoutSeconds: env.TRUFFLEHOG_TIMEOUT_SECONDS,
    trufflehogUserAgentSuffix: env.TRUFFLEHOG_USER_AGENT_SUFFIX,
    githubRateLimitMaxRetries: env.GITHUB_RATE_LIMIT_MAX_RETRIES,
    checkIds: env.CHECK_IDS,
    limit: env.LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link loadConfig} when the environment is misconfigured.
 * The message lists every invalid field so operators can fix all issues at once.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
