import { describe, expect, it } from "vitest";
import {
  evaluateLlmFileEligibility,
  matchesLlmIgnorePattern,
} from "../llm/eligibility.js";

describe("LLM file eligibility", () => {
  it("matches basename globs at any repository depth", () => {
    expect(matchesLlmIgnorePattern("logs/application.log", "*.log")).toBe(true);
    expect(matchesLlmIgnorePattern("web/assets/app.min.js", "*.min.js")).toBe(true);
    expect(matchesLlmIgnorePattern("web/assets/app.js", "*.min.js")).toBe(false);
  });

  it("matches directory patterns as complete path segments", () => {
    expect(matchesLlmIgnorePattern("web/node_modules/pkg/index.js", "node_modules/")).toBe(true);
    expect(matchesLlmIgnorePattern("node_modules/pkg/index.js", "node_modules/")).toBe(true);
    expect(matchesLlmIgnorePattern("web/node_modules_backup/index.js", "node_modules/")).toBe(false);
  });

  it("supports repository path globs and normalized separators", () => {
    expect(matchesLlmIgnorePattern("apps\\api\\generated\\client.ts", "generated/**")).toBe(true);
    expect(matchesLlmIgnorePattern("apps/api/logs/error.log", "logs/*.log")).toBe(true);
    expect(matchesLlmIgnorePattern("apps/api/logs/archive/error.log", "logs/*.log")).toBe(false);
  });

  it("reports the exact ignore pattern that made a file ineligible", () => {
    expect(evaluateLlmFileEligibility(
      "services/api/runtime.log",
      100,
      500,
      ["*.min.js", "*.log"]
    )).toEqual({
      eligible: false,
      matchedPattern: "*.log",
      reason: 'File path matches LLM_IGNORE_PATTERNS pattern "*.log"',
    });
  });

  it("applies MAX_FILE_SIZE_KB only as an LLM eligibility decision", () => {
    expect(evaluateLlmFileEligibility("src/app.ts", 10 * 1024 + 1, 10)).toEqual({
      eligible: false,
      reason: "File size (10.0 KB) exceeds MAX_FILE_SIZE_KB limit of 10 KB",
    });
    expect(evaluateLlmFileEligibility("src/app.ts", 10 * 1024, 10)).toEqual({
      eligible: true,
    });
  });
});
