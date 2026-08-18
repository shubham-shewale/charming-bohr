import {
  type FileWorkItem,
  type FindingRef,
  type FindingResult,
  type TruffleHogVerificationMode,
} from "../types.js";
import { buildNonPendingFindingResult } from "../csv/reader.js";
import type { ClaudeAnalyzer } from "../llm/analyzer.js";
import { runTruffleHog, type RunTruffleHogOptions } from "../trufflehog/runner.js";
import { matchDetectionsToFindings } from "../trufflehog/matcher.js";

/**
 * Explicit action returned by the hybrid state machine after evaluating an LLM result.
 */
export type HybridTransitionAction =
  | { type: "COMPLETE_NO_TRUFFLEHOG"; result: FindingResult }
  | { type: "FAIL_NO_TRUFFLEHOG"; result: FindingResult }
  | { type: "SKIP_NO_TRUFFLEHOG"; result: FindingResult }
  | { type: "INVOKE_TRUFFLEHOG"; finding: FindingRef; llmResult: FindingResult };

/**
 * Pure transition function for the Hybrid flow state machine.
 *
 * State transitions:
 * - LLM returns `false_positive` (completed) -> COMPLETE_NO_TRUFFLEHOG (status=completed, no TruffleHog)
 * - LLM returns `likely_secret` (completed) -> INVOKE_TRUFFLEHOG
 * - LLM returns `uncertain` (completed)     -> INVOKE_TRUFFLEHOG
 * - LLM returns failure (status=failed)     -> FAIL_NO_TRUFFLEHOG (status=failed, no TruffleHog)
 * - Finding skipped (status=skipped)        -> SKIP_NO_TRUFFLEHOG (status=skipped, no TruffleHog)
 */
export function transitionAfterLlm(llmResult: FindingResult): HybridTransitionAction {
  // If finding was skipped or failed, no TruffleHog needed
  if (llmResult.status === "skipped" || llmResult.status === "failed") {
    const normalizedResult: FindingResult = {
      ...llmResult,
      trufflehogResult: llmResult.trufflehogResult ?? "",
      trufflehogDetector: llmResult.trufflehogDetector ?? "",
    };
    return {
      type: llmResult.status === "skipped" ? "SKIP_NO_TRUFFLEHOG" : "FAIL_NO_TRUFFLEHOG",
      result: normalizedResult,
    };
  }

  // LLM completed successfully: evaluate 3-valued classification
  if (llmResult.status === "completed") {
    if (llmResult.llmClassification === "false_positive") {
      return {
        type: "COMPLETE_NO_TRUFFLEHOG",
        result: {
          ...llmResult,
          trufflehogResult: "",
          trufflehogDetector: "",
          error: "",
        },
      };
    }

    if (
      llmResult.llmClassification === "likely_secret" ||
      llmResult.llmClassification === "uncertain"
    ) {
      return {
        type: "INVOKE_TRUFFLEHOG",
        finding: llmResult.findingRef,
        llmResult,
      };
    }
  }

  // Fallback if status is completed but classification is missing/unexpected
  return {
    type: "FAIL_NO_TRUFFLEHOG",
    result: {
      ...llmResult,
      status: "failed",
      error: llmResult.error || "missing_or_unrecognized_llm_classification",
      trufflehogResult: "",
      trufflehogDetector: "",
    },
  };
}

export interface HybridFlowOptions {
  claudeAnalyzer: ClaudeAnalyzer;
  trufflehogOptions?: RunTruffleHogOptions;
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
}

/**
 * Executes the Hybrid analysis flow for a single FileWorkItem:
 * 1. Analyzes all pending findings using ClaudeAnalyzer.
 * 2. Evaluates state machine transitions for each finding.
 * 3. Findings classified as `false_positive`, failed, or skipped are finalized without scanner invocation.
 * 4. Findings classified as `likely_secret` or `uncertain` trigger TruffleHog execution.
 * 5. Combines LLM and TruffleHog result columns in terminal states.
 */
export async function executeHybridFlow(
  workItem: FileWorkItem,
  localFilePath: string,
  options: HybridFlowOptions
): Promise<FindingResult[]> {
  // Step 1: Run LLM analysis on the work item
  const llmResults = await options.claudeAnalyzer.analyzeWorkItem(workItem, localFilePath);

  // Step 2: Evaluate state machine transitions
  const resultMap = new Map<FindingRef, FindingResult>();
  const needsTrufflehog: { finding: FindingRef; llmResult: FindingResult }[] = [];

  for (const res of llmResults) {
    const transition = transitionAfterLlm(res);
    switch (transition.type) {
      case "COMPLETE_NO_TRUFFLEHOG":
      case "FAIL_NO_TRUFFLEHOG":
      case "SKIP_NO_TRUFFLEHOG":
        resultMap.set(transition.result.findingRef, transition.result);
        break;
      case "INVOKE_TRUFFLEHOG":
        needsTrufflehog.push({
          finding: transition.finding,
          llmResult: transition.llmResult,
        });
        break;
    }
  }

  // Step 3: Run TruffleHog conditionally if any findings require verification
  if (needsTrufflehog.length > 0) {
    try {
      const thOpts: RunTruffleHogOptions = {
        ...options.trufflehogOptions,
        execFn: options.trufflehogOptions?.execFn ?? options.trufflehogExecFn,
      };
      const detections = await runTruffleHog(localFilePath, thOpts);

      const thResults = matchDetectionsToFindings(
        needsTrufflehog.map((item) => item.finding),
        detections
      );

      for (let i = 0; i < needsTrufflehog.length; i++) {
        const { llmResult } = needsTrufflehog[i]!;
        const thRes = thResults[i]!;

        resultMap.set(llmResult.findingRef, {
          findingRef: llmResult.findingRef,
          status: thRes.status,
          trufflehogResult: thRes.trufflehogResult,
          trufflehogDetector: thRes.trufflehogDetector,
          llmClassification: llmResult.llmClassification,
          llmReason: llmResult.llmReason,
          llmConfidence: llmResult.llmConfidence,
          error: thRes.error || llmResult.error || "",
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      for (const { llmResult } of needsTrufflehog) {
        resultMap.set(llmResult.findingRef, {
          findingRef: llmResult.findingRef,
          status: "failed",
          trufflehogResult: "",
          trufflehogDetector: "",
          llmClassification: llmResult.llmClassification,
          llmReason: llmResult.llmReason,
          llmConfidence: llmResult.llmConfidence,
          error: errMsg,
        });
      }
    }
  }

  // Step 4: Return findings preserving original FileWorkItem order
  return workItem.findings.map((f) => {
    const res = resultMap.get(f);
    if (res) return res;
    return buildNonPendingFindingResult(f);
  });
}
