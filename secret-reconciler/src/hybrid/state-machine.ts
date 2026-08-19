import {
  type FileWorkItem,
  type FindingRef,
  type FindingResult,
} from "../types.js";
import { buildNonPendingFindingResult } from "../csv/reader.js";
import type { ContextualSecretAnalyzer } from "../llm/analyzer.js";
import { runTruffleHog, type RunTruffleHogOptions } from "../trufflehog/runner.js";
import { matchDetectionsToFindings } from "../trufflehog/matcher.js";

/**
 * Explicit action returned after evaluating TruffleHog evidence.
 *
 * Credential validity is owned by TruffleHog. The LLM is permitted to add
 * false-positive context only after the scanner returns `unverified` or
 * `not_detected`; it can never override verified, unknown, or ambiguous
 * verification evidence.
 */
export type VerificationFirstTransition =
  | { type: "COMPLETE_VERIFIED"; result: FindingResult }
  | { type: "COMPLETE_UNKNOWN"; result: FindingResult }
  | { type: "COMPLETE_AMBIGUOUS"; result: FindingResult }
  | { type: "INVOKE_LLM"; finding: FindingRef; verificationResult: FindingResult }
  | { type: "FAIL_VERIFICATION"; result: FindingResult }
  | { type: "SKIP_VERIFICATION"; result: FindingResult };

/**
 * Pure transition function for the verification-first Hybrid flow.
 *
 * - verified  -> terminal; never sent to the LLM
 * - unknown   -> terminal operational uncertainty; never treated as an FP
 * - ambiguous -> terminal manual-correlation outcome; never guessed by the LLM
 * - unverified / not_detected -> invoke the LLM false-positive intelligence layer
 * - failed / skipped -> preserve the processing outcome
 */
export function transitionAfterVerification(
  verificationResult: FindingResult
): VerificationFirstTransition {
  if (verificationResult.status === "failed") {
    return { type: "FAIL_VERIFICATION", result: verificationResult };
  }

  if (verificationResult.status === "skipped") {
    return { type: "SKIP_VERIFICATION", result: verificationResult };
  }

  if (verificationResult.status === "completed") {
    switch (verificationResult.trufflehogResult) {
      case "verified":
        return { type: "COMPLETE_VERIFIED", result: verificationResult };
      case "unknown":
        return { type: "COMPLETE_UNKNOWN", result: verificationResult };
      case "ambiguous":
        return { type: "COMPLETE_AMBIGUOUS", result: verificationResult };
      case "unverified":
      case "not_detected":
        return {
          type: "INVOKE_LLM",
          finding: verificationResult.findingRef,
          verificationResult,
        };
    }
  }

  return {
    type: "FAIL_VERIFICATION",
    result: {
      ...verificationResult,
      status: "failed",
      error:
        verificationResult.error || "missing_or_unrecognized_trufflehog_result",
    },
  };
}

export interface HybridFlowOptions {
  contextualAnalyzer?: ContextualSecretAnalyzer;
  /** @deprecated Use contextualAnalyzer. */
  claudeAnalyzer?: ContextualSecretAnalyzer;
  trufflehogOptions?: RunTruffleHogOptions;
  /** Backwards-compatible executor injection used by existing callers/tests. */
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
  signal?: AbortSignal;
}

function mergeLlmWithVerification(
  llmResult: FindingResult,
  verificationResult: FindingResult
): FindingResult {
  return {
    ...llmResult,
    findingRef: verificationResult.findingRef,
    trufflehogResult: verificationResult.trufflehogResult,
    trufflehogDetector: verificationResult.trufflehogDetector,
    error: llmResult.error || verificationResult.error || "",
  };
}

/**
 * Executes one verification-first Hybrid File Work Item:
 *
 * 1. Run TruffleHog once for every pending finding in the fetched file.
 * 2. Finalize verified, unknown, and ambiguous results without invoking the LLM.
 * 3. Send only unverified and not-detected findings to the LLM.
 * 4. Merge the LLM classification without allowing it to replace scanner evidence.
 */
export async function executeHybridFlow(
  workItem: FileWorkItem,
  localFilePath: string,
  options: HybridFlowOptions
): Promise<FindingResult[]> {
  const contextualAnalyzer = options.contextualAnalyzer ?? options.claudeAnalyzer;
  const resultMap = new Map<FindingRef, FindingResult>();
  const pendingFindings = workItem.findings.filter(
    (finding) => finding.initialStatus === "pending"
  );

  for (const finding of workItem.findings) {
    if (finding.initialStatus !== "pending") {
      resultMap.set(finding, buildNonPendingFindingResult(finding));
    }
  }

  if (pendingFindings.length === 0) {
    return workItem.findings.map((finding) => resultMap.get(finding)!);
  }

  let verificationResults: FindingResult[];
  try {
    const trufflehogOptions: RunTruffleHogOptions = {
      ...options.trufflehogOptions,
      execFn: options.trufflehogOptions?.execFn ?? options.trufflehogExecFn,
      signal: options.signal ?? options.trufflehogOptions?.signal,
    };
    const detections = await runTruffleHog(localFilePath, trufflehogOptions);
    verificationResults = matchDetectionsToFindings(pendingFindings, detections);
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const finding of pendingFindings) {
      resultMap.set(finding, {
        findingRef: finding,
        status: "failed",
        trufflehogResult: "",
        trufflehogDetector: "",
        error: message,
      });
    }
    return workItem.findings.map((finding) => resultMap.get(finding)!);
  }

  const needsLlm: Array<{
    finding: FindingRef;
    verificationResult: FindingResult;
  }> = [];

  for (const verificationResult of verificationResults) {
    const transition = transitionAfterVerification(verificationResult);
    if (transition.type === "INVOKE_LLM") {
      needsLlm.push({
        finding: transition.finding,
        verificationResult: transition.verificationResult,
      });
    } else {
      resultMap.set(transition.result.findingRef, transition.result);
    }
  }

  if (needsLlm.length > 0) {
    if (!contextualAnalyzer) {
      for (const { finding, verificationResult } of needsLlm) {
        resultMap.set(finding, {
          ...verificationResult,
          status: "completed",
          llmClassification: "uncertain",
          llmConfidence: 0,
          llmReason: "Context classifier is disabled; manual review required",
          error: "",
        });
      }
      return workItem.findings.map((finding) => resultMap.get(finding)!);
    }

    const llmWorkItem: FileWorkItem = {
      ...workItem,
      findings: needsLlm.map(({ finding }) => finding),
    };

    try {
      const verificationResultMap = new Map(
        needsLlm.map(({ finding, verificationResult }) => [finding, verificationResult])
      );
      const llmResults = await contextualAnalyzer.analyzeWorkItem(
        llmWorkItem,
        localFilePath,
        { verificationResults: verificationResultMap, signal: options.signal }
      );
      const llmResultMap = new Map(
        llmResults.map((result) => [result.findingRef, result])
      );

      for (const { finding, verificationResult } of needsLlm) {
        const llmResult = llmResultMap.get(finding);
        if (!llmResult) {
          resultMap.set(finding, {
            ...verificationResult,
            status: "failed",
            error: "missing_llm_result",
          });
          continue;
        }
        resultMap.set(
          finding,
          mergeLlmWithVerification(llmResult, verificationResult)
        );
      }
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      for (const { finding, verificationResult } of needsLlm) {
        resultMap.set(finding, {
          ...verificationResult,
          status: "completed",
          llmClassification: "uncertain",
          llmConfidence: 0,
          llmReason: `AI Gateway analysis failed: ${message}`,
          error: "ai_gateway_error",
        });
      }
    }
  }

  return workItem.findings.map((finding) => {
    const result = resultMap.get(finding);
    if (result) return result;
    return {
      findingRef: finding,
      status: "failed",
      trufflehogResult: "",
      trufflehogDetector: "",
      error: "hybrid_state_machine_missing_result",
    };
  });
}
