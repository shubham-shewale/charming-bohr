import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import type { FindingResult } from "../types.js";

/**
 * Result column names added by secret-reconciler.
 */
export const RESULT_COLUMNS = [
  "source_file",
  "status",
  "trufflehog_result",
  "trufflehog_detector",
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
  const normalizedOriginals = originalHeaders.map((h) => ({
    original: h,
    norm: h.trim().toLowerCase(),
  }));

  const finalHeaders: string[] = [...originalHeaders];

  for (const col of RESULT_COLUMNS) {
    const existing = normalizedOriginals.find((h) => h.norm === col);
    if (!existing) {
      finalHeaders.push(col);
    }
  }

  // Build CSV records
  const records = results.map((res) => {
    const row: Record<string, string> = { ...res.findingRef.rawRow };

    // Fill/overwrite result values
    setColumnValue(row, finalHeaders, "source_file", res.findingRef.sourceFile);
    setColumnValue(row, finalHeaders, "status", res.status);
    setColumnValue(row, finalHeaders, "trufflehog_result", res.trufflehogResult);
    setColumnValue(row, finalHeaders, "trufflehog_detector", res.trufflehogDetector);
    setColumnValue(row, finalHeaders, "error", res.error);

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
  const existingHeader = headers.find((h) => h.trim().toLowerCase() === targetCol);
  const keyToUse = existingHeader ?? targetCol;
  row[keyToUse] = value;
}
