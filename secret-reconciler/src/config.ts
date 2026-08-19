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
const optionalCommaSeparatedList = z
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

/** Parses an optional non-negative decimal, used for per-million token prices. */
const optionalNonNegativeNumber = z
  .string()
  .optional()
  .transform((val, ctx) => {
    if (val === undefined || val.trim() === "") return undefined;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a non-negative number but got "${val}".`,
      });
      return z.NEVER;
    }
    return n;
  });

function optionalBooleanString(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val.trim() === "") return defaultValue;
      if (val === "true") return true;
      if (val === "false") return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected "true" or "false" but got "${val}".`,
      });
      return z.NEVER;
    });
}

const configSchema = z.object({
  FLOW: z.enum(["trufflehog-only", "llm-only", "hybrid"] as const, {
    errorMap: () => ({
      message: `Must be one of: "trufflehog-only", "llm-only", "hybrid".`,
    }),
  }),
  AI_GATEWAY_URL: optionalTrimmedString,
  AI_GATEWAY_MODEL: optionalTrimmedString,
  AI_GATEWAY_AUTH_TOKEN: optionalTrimmedString,
  AI_GATEWAY_TIMEOUT_SECONDS: optionalRangedIntString(1, 30),
  AI_GATEWAY_PROMPT_CACHE_KEY: optionalTrimmedString,
  AI_GATEWAY_PROMPT_CACHE_RETENTION: z.enum(["in_memory", "24h"] as const).optional(),
  AI_GATEWAY_INPUT_COST_PER_MILLION_USD: optionalNonNegativeNumber,
  AI_GATEWAY_OUTPUT_COST_PER_MILLION_USD: optionalNonNegativeNumber,
  AI_GATEWAY_CACHED_INPUT_COST_PER_MILLION_USD: optionalNonNegativeNumber,
  LLM_CONTEXT_CLASSIFIER_ENABLED: optionalBooleanString(true),
  LLM_DETECTOR_ADVISOR_ENABLED: optionalBooleanString(false),
  LLM_MAX_CONTEXT_EXPANSIONS: optionalRangedIntString(0, 2),
  LLM_MAX_CONTEXT_LINES: optionalRangedIntString(1, 150),
  LLM_IGNORE_PATTERNS: optionalCommaSeparatedList,
  LLM_PROMPT_PROFILE: z
    .enum(["context-classifier-v1", "context-classifier-v2"] as const)
    .optional()
    .default("context-classifier-v2"),
  LLM_DETECTOR_PROMPT_PROFILE: z.literal("detector-advisor-v1").optional().default("detector-advisor-v1"),
  MAX_TOKENS_PER_REQUEST: optionalPositiveInt,
  MAX_LLM_CALLS_PER_FILE: optionalPositiveInt,
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
  SURROUNDING_LINES: optionalRangedIntString(0, 10),
  CLEANUP_TEMP_FILES: booleanString,
  TRUFFLEHOG_VERIFICATION_MODE: z
    .enum(["all", "no-verification"] as const, {
      errorMap: () => ({
        message: `Must be one of: "all", "no-verification".`,
      }),
    })
    .optional()
    .default("all"),
  TRUFFLEHOG_TIMEOUT_SECONDS: optionalRangedIntString(1, 60),
  TRUFFLEHOG_USER_AGENT_SUFFIX: optionalTrimmedString,
  TRUFFLEHOG_CONFIG_PATH: optionalTrimmedString,
  CHECK_IDS: optionalCommaSeparatedList,
  LIMIT: optionalPositiveInt,
}).superRefine((env, ctx) => {
  if (env.FLOW === "trufflehog-only") return;

  if (!env.LLM_CONTEXT_CLASSIFIER_ENABLED) {
    if (env.LLM_DETECTOR_ADVISOR_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LLM_DETECTOR_ADVISOR_ENABLED"],
        message: "Detector advice requires LLM context classification.",
      });
    }
    if (env.FLOW === "llm-only") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LLM_CONTEXT_CLASSIFIER_ENABLED"],
        message: "LLM context classification cannot be disabled when FLOW=llm-only.",
      });
    }
    return;
  }

  if (env.AI_GATEWAY_URL) {
    try {
      const url = new URL(env.AI_GATEWAY_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_GATEWAY_URL"],
        message: "AI_GATEWAY_URL must be an absolute HTTP(S) URL.",
      });
    }
  }

  const requiredLlmFields = [
    ["AI_GATEWAY_URL", env.AI_GATEWAY_URL],
    ["AI_GATEWAY_MODEL", env.AI_GATEWAY_MODEL],
    ["MAX_TOKENS_PER_REQUEST", env.MAX_TOKENS_PER_REQUEST],
    ["MAX_LLM_CALLS_PER_FILE", env.MAX_LLM_CALLS_PER_FILE],
  ] as const;

  for (const [field, value] of requiredLlmFields) {
    if (value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when FLOW=${env.FLOW}.`,
      });
    }
  }
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
  aiGatewayUrl?: string;
  aiGatewayModel?: string;
  aiGatewayAuthToken?: string;
  aiGatewayTimeoutSeconds?: number;
  aiGatewayPromptCacheKey?: string;
  aiGatewayPromptCacheRetention?: "in_memory" | "24h";
  aiGatewayInputCostPerMillionUsd?: number;
  aiGatewayOutputCostPerMillionUsd?: number;
  aiGatewayCachedInputCostPerMillionUsd?: number;
  llmContextClassifierEnabled?: boolean;
  llmDetectorAdvisorEnabled?: boolean;
  llmMaxContextExpansions?: number;
  llmMaxContextLines?: number;
  /** Repository-relative path patterns excluded only from LLM analysis. */
  llmIgnorePatterns?: string[];
  llmPromptProfile?: "context-classifier-v1" | "context-classifier-v2";
  llmDetectorPromptProfile?: "detector-advisor-v1";
  /** @deprecated Test-only compatibility field; production uses aiGatewayAuthToken. */
  anthropicApiKey?: string;
  /** @deprecated Test-only compatibility field; production uses aiGatewayModel. */
  anthropicModel?: string;
  /** Required only for `llm-only` and `hybrid` flows. */
  maxTokensPerRequest?: number;
  /** Required only for `llm-only` and `hybrid` flows. */
  maxLlmCallsPerFile?: number;
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
  /** Optional YAML file containing custom TruffleHog detectors and verifiers. */
  trufflehogConfigPath?: string;
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
    aiGatewayUrl: env.AI_GATEWAY_URL,
    aiGatewayModel: env.AI_GATEWAY_MODEL,
    aiGatewayAuthToken: env.AI_GATEWAY_AUTH_TOKEN,
    aiGatewayTimeoutSeconds: env.AI_GATEWAY_TIMEOUT_SECONDS,
    aiGatewayPromptCacheKey: env.AI_GATEWAY_PROMPT_CACHE_KEY,
    aiGatewayPromptCacheRetention: env.AI_GATEWAY_PROMPT_CACHE_RETENTION,
    aiGatewayInputCostPerMillionUsd: env.AI_GATEWAY_INPUT_COST_PER_MILLION_USD,
    aiGatewayOutputCostPerMillionUsd: env.AI_GATEWAY_OUTPUT_COST_PER_MILLION_USD,
    aiGatewayCachedInputCostPerMillionUsd: env.AI_GATEWAY_CACHED_INPUT_COST_PER_MILLION_USD,
    llmContextClassifierEnabled: env.LLM_CONTEXT_CLASSIFIER_ENABLED,
    llmDetectorAdvisorEnabled: env.LLM_DETECTOR_ADVISOR_ENABLED,
    llmMaxContextExpansions: env.LLM_MAX_CONTEXT_EXPANSIONS,
    llmMaxContextLines: env.LLM_MAX_CONTEXT_LINES,
    llmIgnorePatterns: env.LLM_IGNORE_PATTERNS,
    llmPromptProfile: env.LLM_PROMPT_PROFILE,
    llmDetectorPromptProfile: env.LLM_DETECTOR_PROMPT_PROFILE,
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
    trufflehogConfigPath: env.TRUFFLEHOG_CONFIG_PATH,
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
