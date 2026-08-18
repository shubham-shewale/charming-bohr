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
