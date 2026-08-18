import path from "node:path";
import type { FileWorkItem, FindingRef, FindingResult } from "../types.js";
import { buildCodeContext } from "./context-builder.js";
import { redactFocalValues, redactSensitiveContent } from "./redactor.js";

export interface ContextEnvelope {
  findingIndex: number;
  ruleId: string;
  trufflehogResult?: string;
  trufflehogDetector?: string;
  path: string;
  extension: string;
  pathTokens: string[];
  structuralSignals: string[];
  lineStart: number;
  lineEnd: number;
  redactedContext: string;
  contextTruncated: boolean;
}

function getRuleId(finding: FindingRef, fallback: string): string {
  if (finding.checkId) return finding.checkId;
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(finding.rawRow)) {
    if (value.trim()) {
      normalized.set(key.trim().toLowerCase().replace(/[\s_]+/g, ""), value.trim());
    }
  }
  return (
    normalized.get("ruleid") ??
    normalized.get("checkid") ??
    normalized.get("policyid") ??
    fallback
  );
}

function extractStructuralSignals(content: string): string[] {
  const signals = new Set<string>();
  const checks: Array<[RegExp, string]> = [
    [/^\s*apiVersion\s*:/m, "kubernetes_api_version"],
    [/^\s*kind\s*:\s*(Secret|Deployment|StatefulSet|Ingress|Job|CronJob)\b/im, "kubernetes_resource"],
    [/\bsecretKeyRef\s*:/i, "kubernetes_secret_reference"],
    [/\bserviceAccountName\s*:/i, "service_account_binding"],
    [/\b(ingressClassName|LoadBalancer|external-dns)\b/i, "external_exposure_signal"],
    [/\b(provider|resource|module)\s+"[^"]+"/i, "terraform_structure"],
    [/\b(prod|production)\b/i, "production_marker"],
    [/\b(stage|staging)\b/i, "staging_marker"],
    [/\b(test|fixture|mock|example|sample)\b/i, "test_or_example_marker"],
    [/\b(internal|intranet|private)\b/i, "internal_scope_marker"],
    [/\b(host|hostname|endpoint|url|uri)\s*[:=]/i, "endpoint_configuration"],
    [/\b(user(name)?|service[_-]?account|principal)\s*[:=]/i, "principal_configuration"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(content)) signals.add(label);
  }
  return [...signals];
}

function tokenizePath(filePath: string): string[] {
  return filePath
    .toLowerCase()
    .split(/[\\/._-]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 30);
}

export function assembleContextEnvelope(
  workItem: FileWorkItem,
  finding: FindingRef,
  findingIndex: number,
  fileContent: string,
  verificationResult: FindingResult | undefined,
  options: { surroundingLines: number; maxBytes: number; maxLines: number }
): ContextEnvelope {
  const lineStart = finding.canonicalSource?.lineStart ?? 1;
  const lineEnd = finding.canonicalSource?.lineEnd ?? lineStart;
  const redacted = redactFocalValues(
    redactSensitiveContent(fileContent),
    lineStart,
    lineEnd
  );
  const context = buildCodeContext(
    redacted,
    [{ lineStart, lineEnd, title: getRuleId(finding, `Finding ${findingIndex}`) }],
    {
      surroundingLines: options.surroundingLines,
      maxBytes: options.maxBytes,
      maxLines: options.maxLines,
    }
  );

  return {
    findingIndex,
    ruleId: getRuleId(finding, `Finding ${findingIndex}`),
    trufflehogResult: verificationResult?.trufflehogResult,
    trufflehogDetector: verificationResult?.trufflehogDetector,
    path: workItem.filePath,
    extension: path.extname(workItem.filePath).toLowerCase(),
    pathTokens: tokenizePath(workItem.filePath),
    structuralSignals: extractStructuralSignals(redacted),
    lineStart,
    lineEnd,
    redactedContext: context.formattedContext,
    contextTruncated: context.truncated,
  };
}

export function buildAdditionalContext(
  fileContent: string,
  lineStart: number,
  lineEnd: number,
  maxLines: number
): string {
  const safeStart = Math.max(1, lineStart);
  const safeEnd = Math.min(safeStart + maxLines - 1, Math.max(safeStart, lineEnd));
  const redacted = redactFocalValues(
    redactSensitiveContent(fileContent),
    safeStart,
    safeEnd
  );
  return buildCodeContext(
    redacted,
    [{ lineStart: safeStart, lineEnd: safeEnd }],
    { surroundingLines: 0, maxLines }
  ).formattedContext;
}

export interface FileSearchOptions {
  pattern: string;
  mode: "literal" | "regex";
  caseSensitive: boolean;
  maxResults?: number;
  surroundingLines?: number;
}

export interface FileSearchResult {
  matchingLines: number[];
  totalMatches: number;
  redactedContext: string;
  truncated: boolean;
  error?: string;
}

/**
 * Accepts a deliberately small, line-oriented regex subset. Grouping,
 * lookarounds, counted repetition, and highly repetitive quantifiers are
 * rejected so a model-generated search cannot monopolize the Node event loop.
 */
function validateSearchRegex(pattern: string): string | undefined {
  if (pattern.length === 0 || pattern.length > 120 || /[\r\n]/.test(pattern)) {
    return "regex must contain 1-120 characters on one line";
  }
  let escaped = false;
  let quantifierCount = 0;
  for (const character of pattern) {
    if (escaped) {
      if (/[1-9]/.test(character)) {
        return "regex groups, counted repetition, lookarounds, and backreferences are not supported";
      }
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if ("(){}".includes(character)) {
      return "regex groups, counted repetition, lookarounds, and backreferences are not supported";
    }
    if ("+*?".includes(character)) quantifierCount++;
  }
  if (quantifierCount > 3 || /\.\*.*\.\*/.test(pattern)) {
    return "regex contains too many unbounded quantifiers";
  }
  if (escaped) {
    return "regex is invalid";
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    return "regex is invalid";
  }
  return undefined;
}

/** Searches only the already-fetched file and returns bounded, redacted evidence. */
export function searchCurrentFile(
  fileContent: string,
  options: FileSearchOptions
): FileSearchResult {
  const maxResults = Math.min(20, Math.max(1, options.maxResults ?? 20));
  const surroundingLines = Math.min(3, Math.max(0, options.surroundingLines ?? 2));
  const redacted = redactSensitiveContent(fileContent);
  const lines = redacted.split(/\r?\n/);

  let matches: (line: string) => boolean;
  if (options.mode === "regex") {
    const error = validateSearchRegex(options.pattern);
    if (error) {
      return {
        matchingLines: [],
        totalMatches: 0,
        redactedContext: "",
        truncated: false,
        error,
      };
    }
    const regex = new RegExp(options.pattern, options.caseSensitive ? "u" : "iu");
    matches = (line) => regex.test(line.slice(0, 2_000));
  } else {
    if (options.pattern.length === 0 || options.pattern.length > 120) {
      return {
        matchingLines: [],
        totalMatches: 0,
        redactedContext: "",
        truncated: false,
        error: "literal search must contain 1-120 characters",
      };
    }
    const needle = options.caseSensitive ? options.pattern : options.pattern.toLowerCase();
    matches = (line) => {
      const searchable = options.caseSensitive ? line : line.toLowerCase();
      return searchable.slice(0, 2_000).includes(needle);
    };
  }

  const allMatchingLines: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (matches(lines[index]!)) allMatchingLines.push(index + 1);
  }
  const matchingLines = allMatchingLines.slice(0, maxResults);

  // Hide the complete scalar on every matched line. The response still proves
  // that the requested pattern matched that line, while avoiding value leaks.
  let outputContent = redacted;
  for (const line of matchingLines) {
    outputContent = redactFocalValues(outputContent, line, line);
  }
  const context = matchingLines.length > 0
    ? buildCodeContext(
        outputContent,
        matchingLines.map((line) => ({ lineStart: line, lineEnd: line })),
        { surroundingLines, maxLines: 100, maxBytes: 32 * 1024 }
      )
    : { formattedContext: "", truncated: false };

  return {
    matchingLines,
    totalMatches: allMatchingLines.length,
    redactedContext: context.formattedContext,
    truncated: allMatchingLines.length > matchingLines.length || context.truncated,
  };
}
