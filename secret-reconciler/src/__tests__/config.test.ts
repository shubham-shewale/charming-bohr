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
});

afterEach(() => {
  // Restore process.env after each test
  for (const key of Object.keys(VALID_ENV)) {
    delete process.env[key];
  }
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
    expect(config.githubPat).toBe("ghp_test_pat");
    expect(config.concurrency).toBe(5);
    expect(config.maxFileSizeKb).toBe(500);
    expect(config.surroundingLines).toBe(10);
    expect(config.cleanupTempFiles).toBe(true);
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
    expect(() => loadConfig()).not.toThrow();
  });

  it("accepts AZURE_DEVOPS_PAT when present", () => {
    withEnv({ AZURE_DEVOPS_PAT: "ado-token" });
    process.env["AZURE_DEVOPS_PAT"] = "ado-token";
    const config = loadConfig();
    expect(config.azureDevOpsPat).toBe("ado-token");
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
