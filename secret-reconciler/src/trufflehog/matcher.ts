import type {
  FileWorkItem,
  FindingRef,
  FindingResult,
  TruffleHogDetection,
  TruffleHogResult,
} from "../types.js";

/**
 * Matches TruffleHog detections back to finding references by line-range overlap.
 *
 * Overlap condition:
 * detection.lineStart <= finding.lineEnd && detection.lineEnd >= finding.lineStart
 *
 * Produces a {@link FindingResult} for each finding in the list.
 */
export function matchDetectionsToFindings(
  findings: FindingRef[],
  detections: TruffleHogDetection[]
): FindingResult[] {
  return findings.map((finding) => {
    // If finding is already in a terminal/non-pending status, preserve it
    if (finding.initialStatus !== "pending") {
      return {
        findingRef: finding,
        status: finding.initialStatus,
        trufflehogResult: (finding.rawRow["trufflehog_result"] as TruffleHogResult) ?? "",
        trufflehogDetector: finding.rawRow["trufflehog_detector"] ?? "",
        error: finding.parseError?.message ?? finding.rawRow["error"] ?? "",
      };
    }

    if (!finding.canonicalSource) {
      return {
        findingRef: finding,
        status: "skipped",
        trufflehogResult: "",
        trufflehogDetector: "",
        error: finding.parseError?.message ?? "Missing Canonical Source",
      };
    }

    const { lineStart: fStart, lineEnd: fEnd } = finding.canonicalSource;

    // Find detections whose line range overlaps with the finding's line range
    const matches = detections.filter(
      (d) => d.lineStart <= fEnd && d.lineEnd >= fStart
    );

    if (matches.length === 0) {
      return {
        findingRef: finding,
        status: "completed",
        trufflehogResult: "not_found",
        trufflehogDetector: "",
        error: "",
      };
    }

    const hasVerified = matches.some((d) => d.verified);
    const trufflehogResult: TruffleHogResult = hasVerified ? "verified" : "unverified";
    const uniqueDetectors = Array.from(new Set(matches.map((d) => d.detectorName))).join(", ");

    return {
      findingRef: finding,
      status: "completed",
      trufflehogResult,
      trufflehogDetector: uniqueDetectors,
      error: "",
    };
  });
}

/**
 * Produces failed {@link FindingResult} objects for all findings in a FileWorkItem when
 * fetching or scanning fails for that work item.
 */
export function produceErrorResultsForWorkItem(
  workItem: FileWorkItem,
  errorMessage: string
): FindingResult[] {
  return workItem.findings.map((finding) => ({
    findingRef: finding,
    status: "failed",
    trufflehogResult: "",
    trufflehogDetector: "",
    error: errorMessage,
  }));
}
