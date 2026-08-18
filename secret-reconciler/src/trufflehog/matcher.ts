import {
  type FileWorkItem,
  type FindingRef,
  type FindingResult,
  type TruffleHogDetection,
} from "../types.js";
import { buildNonPendingFindingResult } from "../csv/reader.js";

/**
 * Matches TruffleHog detections back to finding references conservatively.
 *
 * Overlap condition:
 * detection.lineStart <= finding.lineEnd && detection.lineEnd >= finding.lineStart
 *
 * Line overlap is accepted only when it produces a one-to-one correlation.
 * Missing location metadata, one detection overlapping multiple findings, or
 * multiple detections overlapping one finding produces `ambiguous` instead of
 * guessing.
 */
export function matchDetectionsToFindings(
  findings: FindingRef[],
  detections: TruffleHogDetection[]
): FindingResult[] {
  return findings.map((finding) => {
    // If finding is already in a terminal/non-pending status, preserve it
    if (finding.initialStatus !== "pending") {
      return buildNonPendingFindingResult(finding);
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

    const locatedDetections = detections.filter(
      (d) => d.lineStart !== undefined && d.lineEnd !== undefined
    );
    const hasLocationlessDetection = locatedDetections.length !== detections.length;

    if (hasLocationlessDetection) {
      return {
        findingRef: finding,
        status: "completed",
        trufflehogResult: "ambiguous",
        trufflehogDetector: "",
        error: "TruffleHog detection is missing source location metadata",
      };
    }

    // Find detections whose line range overlaps with the finding's line range.
    const matches = locatedDetections.filter(
      (d) => d.lineStart! <= fEnd && d.lineEnd! >= fStart
    );

    if (matches.length === 0) {
      return {
        findingRef: finding,
        status: "completed",
        trufflehogResult: "not_detected",
        trufflehogDetector: "",
        error: "",
      };
    }

    if (matches.length > 1) {
      return {
        findingRef: finding,
        status: "completed",
        trufflehogResult: "ambiguous",
        trufflehogDetector: Array.from(new Set(matches.map((d) => d.detectorName))).join(", "),
        error: "Multiple TruffleHog detections overlap this finding",
      };
    }

    const match = matches[0]!;
    const competingFindings = findings.filter((candidate) => {
      if (candidate.initialStatus !== "pending" || !candidate.canonicalSource) return false;
      const candidateSource = candidate.canonicalSource;
      return match.lineStart! <= candidateSource.lineEnd && match.lineEnd! >= candidateSource.lineStart;
    });

    if (competingFindings.length > 1) {
      return {
        findingRef: finding,
        status: "completed",
        trufflehogResult: "ambiguous",
        trufflehogDetector: match.detectorName,
        error: "One TruffleHog detection overlaps multiple findings",
      };
    }

    return {
      findingRef: finding,
      status: "completed",
      trufflehogResult: match.verificationStatus,
      trufflehogDetector: match.detectorName,
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
