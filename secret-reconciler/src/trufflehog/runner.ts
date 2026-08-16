import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TruffleHogDetection } from "../types.js";

const execFileAsync = promisify(execFile);

export interface RunTruffleHogOptions {
  timeoutMs?: number;
  /** Custom executor override for testing. */
  execFn?: (
    command: string,
    args: string[],
    options: { timeout?: number }
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Runs TruffleHog filesystem scan on a local file: `trufflehog filesystem --file {path} --json`
 * Parses stdout JSON lines into {@link TruffleHogDetection} items.
 */
export async function runTruffleHog(
  filePath: string,
  options: RunTruffleHogOptions = {}
): Promise<TruffleHogDetection[]> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const executor = options.execFn ?? (async (cmd, args, opts) => {
    return await execFileAsync(cmd, args, opts);
  });

  let stdout = "";
  try {
    const res = await executor("trufflehog", ["filesystem", "--file", filePath, "--json"], {
      timeout: timeoutMs,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const errorObj = err as { stdout?: string; stderr?: string; message?: string };
    // TruffleHog may return stdout along with exit code or error
    if (errorObj && typeof errorObj.stdout === "string" && errorObj.stdout.trim().length > 0) {
      stdout = errorObj.stdout;
    } else {
      const stderrMsg = errorObj && typeof errorObj.stderr === "string" && errorObj.stderr.trim().length > 0
        ? `: ${errorObj.stderr.trim()}`
        : "";
      const errMsg = errorObj?.message || String(err);
      throw new Error(`TruffleHog execution failed: ${errMsg}${stderrMsg}`);
    }
  }

  return parseTruffleHogOutput(stdout);
}

/**
 * Parses JSON lines output from TruffleHog stdout.
 */
export function parseTruffleHogOutput(stdout: string): TruffleHogDetection[] {
  const detections: TruffleHogDetection[] = [];

  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    try {
      const record = JSON.parse(line);

      const detectorName =
        record.DetectorName ||
        record.DetectorType ||
        record.Detector ||
        record.detector_name ||
        "Unknown";

      const verified = Boolean(record.Verified ?? record.verified);

      // Extract line numbers from SourceMetadata or top-level properties
      const fsData = record.SourceMetadata?.Data?.Filesystem;
      const gitData = record.SourceMetadata?.Data?.Git;
      const lineData = fsData || gitData || record;

      let lineStart =
        lineData.line ??
        lineData.line_number ??
        lineData.start_line ??
        record.line ??
        record.line_number;

      let lineEnd =
        lineData.end_line ??
        record.end_line ??
        lineStart;

      if (typeof lineStart === "string") lineStart = parseInt(lineStart, 10);
      if (typeof lineEnd === "string") lineEnd = parseInt(lineEnd, 10);

      if (typeof lineStart !== "number" || isNaN(lineStart) || lineStart <= 0) {
        lineStart = 1;
        lineEnd = Number.MAX_SAFE_INTEGER;
      } else if (typeof lineEnd !== "number" || isNaN(lineEnd) || lineEnd <= 0) {
        lineEnd = lineStart;
      }

      detections.push({
        detectorName: String(detectorName),
        verified,
        lineStart,
        lineEnd,
        raw: record.Raw || record.Redacted || undefined,
      });
    } catch {
      // Ignore unparseable non-JSON stdout lines
    }
  }

  return detections;
}
