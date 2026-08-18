import type { SecretContextAssessment } from "../types.js";

/**
 * Applies deterministic confidence guardrails after model schema validation.
 * Model confidence is descriptive; it never controls verification or suppression.
 */
export function enforceEvidencePolicy(
  assessment: SecretContextAssessment
): SecretContextAssessment {
  const sources = new Set(assessment.evidence.map((item) => item.source));
  let evidenceStrength = assessment.evidenceStrength;
  let confidence = assessment.confidence;
  let exposureScope = assessment.exposureScope;
  let principalScope = assessment.principalScope;

  if (sources.size === 0 || (sources.size === 1 && sources.has("path"))) {
    evidenceStrength = "weak";
    confidence = Math.min(confidence, 0.6);
  } else if (sources.size === 1 && evidenceStrength === "strong") {
    evidenceStrength = "moderate";
    confidence = Math.min(confidence, 0.8);
  }

  if (
    exposureScope === "internet_facing" &&
    !assessment.evidence.some((item) => item.source !== "path")
  ) {
    exposureScope = "unknown";
  }

  if (
    principalScope !== "unknown" &&
    !assessment.evidence.some((item) => item.source !== "path")
  ) {
    principalScope = "unknown";
  }

  return {
    ...assessment,
    evidenceStrength,
    confidence,
    exposureScope,
    principalScope,
  };
}

/** Rejects regex constructs that cannot be reviewed safely as a Go/RE2 proposal. */
export function validateDetectorRegexProposal(regex: string | undefined): string | undefined {
  if (!regex) return undefined;
  if (/\(\?<([=!])/.test(regex) || /\\[1-9]/.test(regex)) {
    return undefined;
  }
  if (regex.includes("REDACTED_SECRET") || regex.length > 1000) {
    return undefined;
  }
  return regex;
}
