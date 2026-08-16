import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import type { FindingResult } from "../types.js";
import { normalizeHeader } from "./reader.js";

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
  const seenNormHeaders = new Set<string>();
  const finalHeaders: string[] = [];

  for (const h of originalHeaders) {
    const norm = normalizeHeader(h);
    if (!seenNormHeaders.has(norm)) {
      seenNormHeaders.add(norm);
      finalHeaders.push(h);
    }
  }

  for (const col of RESULT_COLUMNS) {
    const normCol = normalizeHeader(col);
    if (!seenNormHeaders.has(normCol)) {
      seenNormHeaders.add(normCol);
      finalHeaders.push(col);
    }
  }

  // Build CSV records
  const records = results.map((res) => {
    const row: Record<string, string> = { ...res.findingRef.rawRow };

    // Determine LLM classification value for CSV (including llm_invalid_output on failed LLM parses)
    let classificationStr = res.llmClassification ?? "";
    if (!classificationStr && res.status === "failed" && res.error === "llm_invalid_output") {
      classificationStr = "llm_invalid_output" as const;
    }

    const confidenceStr =
      res.llmConfidence !== undefined ? String(res.llmConfidence) : "";

    // Fill/overwrite result values
    setColumnValue(row, finalHeaders, "source_file", res.findingRef.sourceFile);
    setColumnValue(row, finalHeaders, "status", res.status);
    setColumnValue(row, finalHeaders, "trufflehog_result", res.trufflehogResult ?? "");
    setColumnValue(row, finalHeaders, "trufflehog_detector", res.trufflehogDetector ?? "");
    setColumnValue(row, finalHeaders, "llm_classification", classificationStr);
    setColumnValue(row, finalHeaders, "llm_reason", res.llmReason ?? "");
    setColumnValue(row, finalHeaders, "llm_confidence", confidenceStr);
    setColumnValue(row, finalHeaders, "error", res.error ?? "");

    return row;
  });

  const outputContent = stringify(records, {
    header: true,
    columns: finalHeaders,
  });

  fs.writeFileSync(outputPath, outputContent, { encoding: "utf-8" });
}

function setColumnValue(
  row: Record<string, string>,
  headers: string[],
  targetCol: string,
  value: string
): void {
  const normTarget = normalizeHeader(targetCol);
  const existingHeader = headers.find((h) => normalizeHeader(h) === normTarget);
  const keyToUse = existingHeader ?? targetCol;
  row[keyToUse] = value;
}
