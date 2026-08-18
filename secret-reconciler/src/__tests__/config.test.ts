import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A complete valid set of environment variables. */
const VALID_ENV: Record<string, string> = {
  FLOW: "hybrid",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
  ANTHROPIC_MODEL: "claude-3-5-sonnet-20241022",
  MAX_TOKENS_PER_REQUEST: "4096",
  MAX_LLM_CALLS_PER_FILE: "3",
  GITHUB_PAT: "ghp_test_pat",
  CONCURRENCY: "5",
  MAX_FILE_SIZE_KB: "500",
  SURROUNDING_LINES: "10",
  CLEANUP_TEMP_FILES: "true",
};

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Snapshot process.env before each test and inject a clean valid env
  originalEnv = { ...process.env };
  // Clear relevant keys so tests are isolated
  for (const key of Object.keys(VALID_ENV)) {
    delete process.env[key];
  }
  delete process.env["AZURE_DEVOPS_PAT"];
  delete process.env["TRUFFLEHOG_VERIFICATION_MODE"];
  delete process.env["TRUFFLEHOG_TIMEOUT_SECONDS"];
  delete process.env["TRUFFLEHOG_USER_AGENT_SUFFIX"];
  delete process.env["GITHUB_RATE_LIMIT_MAX_RETRIES"];
  delete process.env["CHECK_IDS"];
  delete process.env["LIMIT"];
});

afterEach(() => {
  // Restore process.env after each test
  for (const key of Object.keys(VALID_ENV)) {
    delete process.env[key];
  }
  delete process.env["TRUFFLEHOG_VERIFICATION_MODE"];
  delete process.env["TRUFFLEHOG_TIMEOUT_SECONDS"];
  delete process.env["TRUFFLEHOG_USER_AGENT_SUFFIX"];
  delete process.env["GITHUB_RATE_LIMIT_MAX_RETRIES"];
  delete process.env["CHECK_IDS"];
  delete process.env["LIMIT"];
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
});

/** Inject the given env vars into process.env before calling loadConfig(). */
function withEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries({ ...VALID_ENV, ...overrides })) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Valid configuration
// ---------------------------------------------------------------------------

describe("loadConfig — valid configuration", () => {
  it("returns a parsed config object when all required fields are present", () => {
    withEnv({});

    const config = loadConfig();

    expect(config.flow).toBe("hybrid");
    expect(config.anthropicApiKey).toBe("sk-ant-test-key");
    expect(config.anthropicModel).toBe("claude-3-5-sonnet-20241022");
    expect(config.maxTokensPerRequest).toBe(4096);
    expect(config.maxLlmCallsPerFile).toBe(3);
    expect(config.githubPats).toEqual(["ghp_test_pat"]);
    expect(config.concurrency).toBe(5);
    expect(config.maxFileSizeKb).toBe(500);
    expect(config.surroundingLines).toBe(10);
    expect(config.cleanupTempFiles).toBe(true);
    expect(config.githubRateLimitMaxRetries).toBe(2); // default
  });

  it("parses CLEANUP_TEMP_FILES=false correctly", () => {
    withEnv({ CLEANUP_TEMP_FILES: "false" });
    const config = loadConfig();
    expect(config.cleanupTempFiles).toBe(false);
  });

  it("accepts FLOW=trufflehog-only", () => {
    withEnv({ FLOW: "trufflehog-only" });
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().flow).toBe("trufflehog-only");
  });

  it("accepts FLOW=llm-only", () => {
    withEnv({ FLOW: "llm-only" });
    expect(loadConfig().flow).toBe("llm-only");
  });

  it("treats AZURE_DEVOPS_PAT as optional — succeeds when absent", () => {
    withEnv({});
    delete process.env["AZURE_DEVOPS_PAT"];
    const config = loadConfig();
    expect(config.azureDevOpsPat).toBeUndefined();
  });

  it("normalizes empty or whitespace AZURE_DEVOPS_PAT to undefined", () => {
    withEnv({ AZURE_DEVOPS_PAT: "" });
    expect(loadConfig().azureDevOpsPat).toBeUndefined();

    withEnv({ AZURE_DEVOPS_PAT: "   " });
    expect(loadConfig().azureDevOpsPat).toBeUndefined();
  });

  it("accepts and trims AZURE_DEVOPS_PAT when present", () => {
    withEnv({ AZURE_DEVOPS_PAT: "  ado-token  " });
    const config = loadConfig();
    expect(config.azureDevOpsPat).toBe("ado-token");
  });

  it("applies TruffleHog defaults when TruffleHog variables are absent", () => {
    withEnv({});
    const config = loadConfig();
    expect(config.trufflehogVerificationMode).toBe("all");
    expect(config.trufflehogTimeoutSeconds).toBe(60);
    expect(config.trufflehogUserAgentSuffix).toBeUndefined();
  });

  it("parses valid TRUFFLEHOG_VERIFICATION_MODE values", () => {
    withEnv({ TRUFFLEHOG_VERIFICATION_MODE: "verified-only" });
    expect(loadConfig().trufflehogVerificationMode).toBe("verified-only");

    withEnv({ TRUFFLEHOG_VERIFICATION_MODE: "no-verification" });
    expect(loadConfig().trufflehogVerificationMode).toBe("no-verification");

    withEnv({ TRUFFLEHOG_VERIFICATION_MODE: "all" });
    expect(loadConfig().trufflehogVerificationMode).toBe("all");
  });

  it("parses valid TRUFFLEHOG_TIMEOUT_SECONDS integers", () => {
    withEnv({ TRUFFLEHOG_TIMEOUT_SECONDS: "120" });
    expect(loadConfig().trufflehogTimeoutSeconds).toBe(120);

    withEnv({ TRUFFLEHOG_TIMEOUT_SECONDS: "1" });
    expect(loadConfig().trufflehogTimeoutSeconds).toBe(1);
  });

  it("normalizes and trims TRUFFLEHOG_USER_AGENT_SUFFIX", () => {
    withEnv({ TRUFFLEHOG_USER_AGENT_SUFFIX: "SecurityTeamAudit-2026" });
    expect(loadConfig().trufflehogUserAgentSuffix).toBe("SecurityTeamAudit-2026");

    withEnv({ TRUFFLEHOG_USER_AGENT_SUFFIX: "  CustomSuffix  " });
    expect(loadConfig().trufflehogUserAgentSuffix).toBe("CustomSuffix");

    withEnv({ TRUFFLEHOG_USER_AGENT_SUFFIX: "" });
    expect(loadConfig().trufflehogUserAgentSuffix).toBeUndefined();

    withEnv({ TRUFFLEHOG_USER_AGENT_SUFFIX: "   " });
    expect(loadConfig().trufflehogUserAgentSuffix).toBeUndefined();
  });

  it("parses comma-separated GITHUB_PAT into an array of trimmed tokens", () => {
    withEnv({ GITHUB_PAT: "ghp_token1, ghp_token2 , ghp_token3" });
    const config = loadConfig();
    expect(config.githubPats).toEqual(["ghp_token1", "ghp_token2", "ghp_token3"]);
  });

  it("parses a single GITHUB_PAT into a one-element array", () => {
    withEnv({ GITHUB_PAT: "ghp_single" });
    expect(loadConfig().githubPats).toEqual(["ghp_single"]);
  });

  it("GITHUB_RATE_LIMIT_MAX_RETRIES defaults to 2 when absent", () => {
    withEnv({});
    expect(loadConfig().githubRateLimitMaxRetries).toBe(2);
  });

  it("GITHUB_RATE_LIMIT_MAX_RETRIES accepts 0 (no retries)", () => {
    withEnv({ GITHUB_RATE_LIMIT_MAX_RETRIES: "0" });
    expect(loadConfig().githubRateLimitMaxRetries).toBe(0);
  });

  it("GITHUB_RATE_LIMIT_MAX_RETRIES accepts custom positive value", () => {
    withEnv({ GITHUB_RATE_LIMIT_MAX_RETRIES: "5" });
    expect(loadConfig().githubRateLimitMaxRetries).toBe(5);
  });

  it("CHECK_IDS defaults to undefined when absent", () => {
    withEnv({});
    expect(loadConfig().checkIds).toBeUndefined();
  });

  it("parses comma-separated CHECK_IDS into an array of trimmed strings", () => {
    withEnv({ CHECK_IDS: "CKV_SECRET_6, CKV_AWS_1 , CKV_GCP_2" });
    expect(loadConfig().checkIds).toEqual(["CKV_SECRET_6", "CKV_AWS_1", "CKV_GCP_2"]);
  });

  it("parses single CHECK_IDS into a one-element array", () => {
    withEnv({ CHECK_IDS: "CKV_SECRET_1" });
    expect(loadConfig().checkIds).toEqual(["CKV_SECRET_1"]);
  });

  it("normalizes empty or whitespace CHECK_IDS to undefined", () => {
    withEnv({ CHECK_IDS: "" });
    expect(loadConfig().checkIds).toBeUndefined();

    withEnv({ CHECK_IDS: "   " });
    expect(loadConfig().checkIds).toBeUndefined();

    withEnv({ CHECK_IDS: "  ,  ,  " });
    expect(loadConfig().checkIds).toBeUndefined();
  });

  it("LIMIT defaults to undefined when absent", () => {
    withEnv({});
    expect(loadConfig().limit).toBeUndefined();
  });

  it("parses valid positive LIMIT integer", () => {
    withEnv({ LIMIT: "100" });
    expect(loadConfig().limit).toBe(100);

    withEnv({ LIMIT: "1" });
    expect(loadConfig().limit).toBe(1);
  });

  it("normalizes empty or whitespace LIMIT to undefined", () => {
    withEnv({ LIMIT: "" });
    expect(loadConfig().limit).toBeUndefined();

    withEnv({ LIMIT: "   " });
    expect(loadConfig().limit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid / missing configuration
// ---------------------------------------------------------------------------

describe("loadConfig — invalid configuration", () => {
  it("throws when GITHUB_PAT is missing", () => {
    withEnv({ GITHUB_PAT: undefined });

    expect(() => loadConfig()).toThrow(/GITHUB_PAT/);
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    withEnv({ ANTHROPIC_API_KEY: undefined });

    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when FLOW has an invalid enum value", () => {
    withEnv({ FLOW: "auto" });

    const err = expect(() => loadConfig()).toThrow();
    try {
      loadConfig();
    } catch (e: unknown) {
      expect(String(e)).toMatch(/FLOW/);
      // Should mention the valid options
      expect(String(e)).toMatch(/trufflehog-only|llm-only|hybrid/);
    }
  });

  it("throws when TRUFFLEHOG_VERIFICATION_MODE is invalid", () => {
    withEnv({ TRUFFLEHOG_VERIFICATION_MODE: "invalid-mode" });
    expect(() => loadConfig()).toThrow(/TRUFFLEHOG_VERIFICATION_MODE/);
  });

  it("throws when TRUFFLEHOG_TIMEOUT_SECONDS is zero", () => {
    withEnv({ TRUFFLEHOG_TIMEOUT_SECONDS: "0" });
    expect(() => loadConfig()).toThrow(/TRUFFLEHOG_TIMEOUT_SECONDS/);
  });

  it("throws when TRUFFLEHOG_TIMEOUT_SECONDS is negative", () => {
    withEnv({ TRUFFLEHOG_TIMEOUT_SECONDS: "-10" });
    expect(() => loadConfig()).toThrow(/TRUFFLEHOG_TIMEOUT_SECONDS/);
  });

  it("throws when TRUFFLEHOG_TIMEOUT_SECONDS is not an integer", () => {
    withEnv({ TRUFFLEHOG_TIMEOUT_SECONDS: "abc" });
    expect(() => loadConfig()).toThrow(/TRUFFLEHOG_TIMEOUT_SECONDS/);
  });

  it("throws when CONCURRENCY is zero", () => {
    withEnv({ CONCURRENCY: "0" });
    expect(() => loadConfig()).toThrow(/CONCURRENCY/);
  });

  it("throws when CONCURRENCY is negative", () => {
    withEnv({ CONCURRENCY: "-3" });
    expect(() => loadConfig()).toThrow(/CONCURRENCY/);
  });

  it("throws when MAX_TOKENS_PER_REQUEST is zero", () => {
    withEnv({ MAX_TOKENS_PER_REQUEST: "0" });
    expect(() => loadConfig()).toThrow(/MAX_TOKENS_PER_REQUEST/);
  });

  it("throws when SURROUNDING_LINES is negative", () => {
    withEnv({ SURROUNDING_LINES: "-1" });
    expect(() => loadConfig()).toThrow(/SURROUNDING_LINES/);
  });

  it("throws when MAX_FILE_SIZE_KB is zero", () => {
    withEnv({ MAX_FILE_SIZE_KB: "0" });
    expect(() => loadConfig()).toThrow(/MAX_FILE_SIZE_KB/);
  });

  it("throws when MAX_FILE_SIZE_KB is negative", () => {
    withEnv({ MAX_FILE_SIZE_KB: "-100" });
    expect(() => loadConfig()).toThrow(/MAX_FILE_SIZE_KB/);
  });

  it("throws when MAX_LLM_CALLS_PER_FILE is negative", () => {
    withEnv({ MAX_LLM_CALLS_PER_FILE: "-1" });
    expect(() => loadConfig()).toThrow(/MAX_LLM_CALLS_PER_FILE/);
  });

  it("throws when CLEANUP_TEMP_FILES is not a boolean-like string", () => {
    withEnv({ CLEANUP_TEMP_FILES: "yes" });
    expect(() => loadConfig()).toThrow(/CLEANUP_TEMP_FILES/);
  });

  it("throws when FLOW is missing entirely", () => {
    withEnv({ FLOW: undefined });
    expect(() => loadConfig()).toThrow(/FLOW/);
  });

  it("throws when GITHUB_PAT contains only commas or empty items", () => {
    withEnv({ GITHUB_PAT: "," });
    expect(() => loadConfig()).toThrow(/GITHUB_PAT/);

    withEnv({ GITHUB_PAT: "  ,   ,  " });
    expect(() => loadConfig()).toThrow(/GITHUB_PAT/);
  });

  it("throws when LIMIT is zero", () => {
    withEnv({ LIMIT: "0" });
    expect(() => loadConfig()).toThrow(/LIMIT/);
  });

  it("throws when LIMIT is negative", () => {
    withEnv({ LIMIT: "-10" });
    expect(() => loadConfig()).toThrow(/LIMIT/);
  });

  it("throws when LIMIT is not an integer", () => {
    withEnv({ LIMIT: "abc" });
    expect(() => loadConfig()).toThrow(/LIMIT/);

    withEnv({ LIMIT: "12.34" });
    expect(() => loadConfig()).toThrow(/LIMIT/);
  });

  it("error message names ALL invalid fields, not just the first", () => {
    // Blow up multiple fields at once — should report all of them
    withEnv({ FLOW: "bad", CONCURRENCY: "-1", GITHUB_PAT: undefined });

    try {
      loadConfig();
      throw new Error("Expected loadConfig to throw");
    } catch (e: unknown) {
      const msg = String(e);
      expect(msg).toMatch(/FLOW/);
      expect(msg).toMatch(/CONCURRENCY/);
      expect(msg).toMatch(/GITHUB_PAT/);
    }
  });
});
