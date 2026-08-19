import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TruffleHogDetection, TruffleHogVerificationMode } from "../types.js";

const execFileAsync = promisify(execFile);

/** Runtime version whose CLI and JSON contract this adapter is tested against. */
export const SUPPORTED_TRUFFLEHOG_VERSION = "3.97.0";

export type TruffleHogExecutor = (
  command: string,
  args: string[],
  options: { timeout?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

export interface RunTruffleHogOptions {
  verificationMode?: TruffleHogVerificationMode;
  userAgentSuffix?: string;
  configPath?: string;
  timeoutMs?: number;
  /** Hard-cancellation signal supplied by the pipeline lifecycle. */
  signal?: AbortSignal;
  /** Custom executor override for testing. */
  execFn?: TruffleHogExecutor;
}

/**
 * Verifies that the installed CLI matches the version whose output contract is
 * implemented by this adapter. Call once during application startup.
 */
export async function assertSupportedTruffleHogVersion(
  options: Pick<RunTruffleHogOptions, "execFn" | "timeoutMs" | "signal"> = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const executor = options.execFn ?? (async (cmd, args, opts) => {
    return await execFileAsync(cmd, args, opts);
  });

  let stdout: string;
  try {
    const result = await executor("trufflehog", ["--version"], {
      timeout: timeoutMs,
      signal: options.signal,
    });
    stdout = result.stdout.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to determine TruffleHog version: ${message}`);
  }

  const versionMatch = stdout.match(/\b(\d+\.\d+\.\d+)\b/);
  const actualVersion = versionMatch?.[1];
  if (actualVersion !== SUPPORTED_TRUFFLEHOG_VERSION) {
    const reportedVersion = actualVersion ?? (stdout || "unknown");
    throw new Error(
      `Unsupported TruffleHog version "${reportedVersion}". ` +
        `Expected ${SUPPORTED_TRUFFLEHOG_VERSION}.`
    );
  }
}

/**
 * Runs TruffleHog filesystem scan on a local file: `trufflehog filesystem {path} --json`.
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

  const args = [
    "filesystem",
    filePath,
    "--json",
    "--results=verified,unverified,unknown",
    "--no-update",
    "--fail-on-scan-errors",
  ];

  if (options.verificationMode === "no-verification") {
    args.push("--no-verification");
  }

  if (options.configPath && options.configPath.trim().length > 0) {
    args.push(`--config=${options.configPath.trim()}`);
  }

  if (options.userAgentSuffix && options.userAgentSuffix.trim().length > 0) {
    args.push(`--user-agent-suffix=${options.userAgentSuffix.trim()}`);
  }

  let stdout = "";
  try {
    const res = await executor("trufflehog", args, {
      timeout: timeoutMs,
      signal: options.signal,
    });
    stdout = res.stdout;
  } catch (err: unknown) {
    const errorObj = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
      timedOut?: boolean;
      code?: string;
    };

    const isTimeout =
      errorObj?.code === "ETIMEDOUT" ||
      errorObj?.timedOut === true ||
      (errorObj?.killed === true && errorObj?.signal === "SIGTERM") ||
      (typeof errorObj?.message === "string" && /timed?\s*out/i.test(errorObj.message));

    if (isTimeout) {
      const seconds = Math.round(timeoutMs / 1000);
      throw new Error(`TruffleHog process timed out after ${seconds}s`);
    }

    // A non-zero process can contain partial stdout. Never treat partial scan
    // output as a successful complete result.
    const stderrMsg = errorObj && typeof errorObj.stderr === "string" && errorObj.stderr.trim().length > 0
      ? `: ${errorObj.stderr.trim()}`
      : "";
    const errMsg = errorObj?.message || String(err);
    throw new Error(`TruffleHog execution failed: ${errMsg}${stderrMsg}`);
  }

  return parseTruffleHogOutput(stdout);
}

/**
 * Parses JSON lines output from TruffleHog stdout.
 */
export function parseTruffleHogOutput(stdout: string): TruffleHogDetection[] {
  const detections: TruffleHogDetection[] = [];

  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      const record = parsed as Record<string, any>;

      const detectorName =
        record.DetectorName ||
        record.DetectorType ||
        record.Detector ||
        record.detector_name;

      if (typeof detectorName !== "string" || detectorName.trim().length === 0) {
        throw new Error("missing detector name");
      }

      const verified = record.Verified ?? record.verified;
      if (typeof verified !== "boolean") {
        throw new Error("missing boolean Verified field");
      }

      const verificationError =
        record.VerificationError ??
        record.verification_error ??
        record.verificationError;
      const hasVerificationError =
        verificationError !== undefined &&
        verificationError !== null &&
        (typeof verificationError !== "string" || verificationError.trim().length > 0);

      const verificationStatus = verified
        ? "verified"
        : hasVerificationError
          ? "unknown"
          : "unverified";

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

      const parsePositiveLine = (value: unknown): number | undefined => {
        const parsedValue = typeof value === "string" ? Number.parseInt(value, 10) : value;
        return typeof parsedValue === "number" && Number.isInteger(parsedValue) && parsedValue > 0
          ? parsedValue
          : undefined;
      };

      lineStart = parsePositiveLine(lineStart);
      lineEnd = parsePositiveLine(lineEnd);
      if (lineStart !== undefined && lineEnd === undefined) lineEnd = lineStart;
      if (lineStart === undefined) lineEnd = undefined;

      detections.push({
        detectorName: detectorName.trim(),
        verificationStatus,
        lineStart,
        lineEnd,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid TruffleHog JSON output at line ${index + 1}: ${reason}`);
    }
  }

  return detections;
}
