import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import type { FindingResult } from "../types.js";
import { mergeHeaders, normalizeHeader } from "./reader.js";

/**
 * Result column names added by secret-reconciler.
 */
export const RESULT_COLUMNS = [
  "source_file",
  "status",
  "trufflehog_result",
  "trufflehog_detector",
  "llm_classification",
  "llm_reason",
  "llm_confidence",
  "llm_evidence_strength",
  "llm_file_role",
  "llm_environment",
  "llm_exposure_scope",
  "llm_principal_scope",
  "llm_secret_kind",
  "llm_evidence",
  "detector_gap_status",
  "detector_gap_reason",
  "detector_gap_proposal",
  "llm_model",
  "llm_prompt_version",
  "error",
] as const;

/**
 * Writes processed finding results to a CSV file.
 * Preserves all original headers and appends result columns.
 */
export function writeResultsCsv(
  outputPath: string,
  results: FindingResult[],
  originalHeaders: string[]
): void {
  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Determine headers map (preserve original header names, append missing result columns)
  const finalHeaders = mergeHeaders(originalHeaders, RESULT_COLUMNS);

  // Precompute column keys for result columns
  const columnKeyMap = new Map<string, string>();
  for (const col of RESULT_COLUMNS) {
    const normTarget = normalizeHeader(col);
    const existingHeader = finalHeaders.find((h) => normalizeHeader(h) === normTarget);
    columnKeyMap.set(col, existingHeader ?? col);
  }

  // Build CSV records
  const records = results.map((res) => {
    const row: Record<string, string> = { ...res.findingRef.rawRow };

    // Determine LLM classification value for CSV (including llm_invalid_output on failed LLM parses)
    let classificationStr = res.llmClassification ?? "";
    if (!classificationStr && res.status === "failed" && res.error === "llm_invalid_output") {
      classificationStr = "llm_invalid_output";
    }

    const confidenceStr =
      res.llmConfidence !== undefined ? String(res.llmConfidence) : "";

    // Fill/overwrite result values
    row[columnKeyMap.get("source_file")!] = res.findingRef.sourceFile;
    row[columnKeyMap.get("status")!] = res.status;
    row[columnKeyMap.get("trufflehog_result")!] = res.trufflehogResult ?? "";
    row[columnKeyMap.get("trufflehog_detector")!] = res.trufflehogDetector ?? "";
    row[columnKeyMap.get("llm_classification")!] = classificationStr;
    row[columnKeyMap.get("llm_reason")!] = res.llmReason ?? "";
    row[columnKeyMap.get("llm_confidence")!] = confidenceStr;
    row[columnKeyMap.get("llm_evidence_strength")!] = res.contextAssessment?.evidenceStrength ?? "";
    row[columnKeyMap.get("llm_file_role")!] = res.contextAssessment?.fileRole ?? "";
    row[columnKeyMap.get("llm_environment")!] = res.contextAssessment?.environment ?? "";
    row[columnKeyMap.get("llm_exposure_scope")!] = res.contextAssessment?.exposureScope ?? "";
    row[columnKeyMap.get("llm_principal_scope")!] = res.contextAssessment?.principalScope ?? "";
    row[columnKeyMap.get("llm_secret_kind")!] = res.contextAssessment?.secretKind ?? "";
    row[columnKeyMap.get("llm_evidence")!] = res.contextAssessment
      ? JSON.stringify({
          evidence: res.contextAssessment.evidence,
          benignSignals: res.contextAssessment.benignSignals,
          riskSignals: res.contextAssessment.riskSignals,
          missingEvidence: res.contextAssessment.missingEvidence,
        })
      : "";
    row[columnKeyMap.get("detector_gap_status")!] = res.detectorGapAssessment?.status ?? "";
    row[columnKeyMap.get("detector_gap_reason")!] = res.detectorGapAssessment?.reason ?? "";
    row[columnKeyMap.get("detector_gap_proposal")!] = res.detectorGapAssessment
      ? JSON.stringify(res.detectorGapAssessment)
      : "";
    row[columnKeyMap.get("llm_model")!] = res.llmModel ?? "";
    row[columnKeyMap.get("llm_prompt_version")!] = res.llmPromptVersion ?? "";
    row[columnKeyMap.get("error")!] = res.error ?? "";

    return row;
  });

  const outputContent = stringify(records, {
    header: true,
    columns: finalHeaders,
  });

  // Write atomically to avoid corrupted output files on interrupt
  const tempPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, outputContent, { encoding: "utf-8" });
    fs.renameSync(tempPath, outputPath);
  } catch {
    // If rename fails (e.g. cross-device link), fallback to direct write
    fs.writeFileSync(outputPath, outputContent, { encoding: "utf-8" });
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }
}
