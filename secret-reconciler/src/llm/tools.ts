import { z } from "zod";
import type { AiGatewayToolDefinition } from "../ai-gateway/types.js";

const evidenceSchema = z.object({
  source: z.enum(["path", "content", "metadata"]),
  description: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
});

export const contextAssessmentSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  classification: z.enum(["probable_secret", "probable_false_positive", "uncertain"]),
  fileRole: z.enum([
    "production_configuration",
    "infrastructure_as_code",
    "deployment_manifest",
    "application_code",
    "test_fixture",
    "documentation",
    "example",
    "generated_file",
    "unknown",
  ]),
  environment: z.enum(["production", "staging", "development", "test", "unknown"]),
  exposureScope: z.enum(["internet_facing", "internal", "restricted", "local_only", "unknown"]),
  principalScope: z.enum([
    "human_user",
    "service_account",
    "application",
    "workload",
    "shared_account",
    "unknown",
  ]),
  secretKind: z.enum([
    "cloud_credential",
    "database_credential",
    "api_token",
    "private_key",
    "password",
    "connection_string",
    "certificate",
    "unknown",
  ]),
  evidenceStrength: z.enum(["strong", "moderate", "weak"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).max(12),
  benignSignals: z.array(z.string().min(1).max(300)).max(12),
  riskSignals: z.array(z.string().min(1).max(300)).max(12),
  missingEvidence: z.array(z.string().min(1).max(300)).max(12),
  reason: z.string().min(1).max(1500),
});

export const submitContextAssessmentsSchema = z.object({
  assessments: z.array(contextAssessmentSchema).min(1),
});

export const additionalContextRequestSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  reason: z.string().min(1).max(300),
});

export const fileSearchRequestSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  pattern: z.string().min(1).max(120),
  mode: z.enum(["literal", "regex"]),
  caseSensitive: z.boolean(),
  reason: z.string().min(1).max(300),
});

export const detectorGapAssessmentSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  status: z.enum([
    "new_detector_candidate",
    "existing_detector_tuning",
    "custom_verifier_candidate",
    "not_a_detector_gap",
    "uncertain",
  ]),
  proposedName: z.string().min(1).max(100).optional(),
  keywords: z.array(z.string().min(1).max(100)).max(20),
  secretShape: z.string().min(1).max(500).optional(),
  regexTemplate: z.string().min(1).max(1000).optional(),
  verificationApproach: z.string().min(1).max(1000).optional(),
  exclusionSuggestions: z.array(z.string().min(1).max(300)).max(20),
  evidence: z.array(z.string().min(1).max(500)).max(20),
  reason: z.string().min(1).max(1500),
});

export const submitDetectorGapAssessmentsSchema = z.object({
  assessments: z.array(detectorGapAssessmentSchema).min(1),
});

export const GET_ADDITIONAL_FILE_CONTEXT_TOOL: AiGatewayToolDefinition = {
  type: "function",
  function: {
    name: "get_additional_file_context",
    description: "Read one bounded, redacted line range from the same fetched file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["findingIndex", "startLine", "endLine", "reason"],
      properties: {
        findingIndex: { type: "integer", minimum: 0 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        reason: { type: "string", minLength: 1, maxLength: 300 },
      },
    },
  },
};

export const SEARCH_CURRENT_FILE_TOOL: AiGatewayToolDefinition = {
  type: "function",
  function: {
    name: "search_current_file",
    description: "Search the already-fetched current file using a literal or restricted line-safe regex and return bounded, redacted matching context.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["findingIndex", "pattern", "mode", "caseSensitive", "reason"],
      properties: {
        findingIndex: { type: "integer", minimum: 0 },
        pattern: { type: "string", minLength: 1, maxLength: 120 },
        mode: { enum: ["literal", "regex"] },
        caseSensitive: { type: "boolean" },
        reason: { type: "string", minLength: 1, maxLength: 300 },
      },
    },
  },
};

export const SUBMIT_CONTEXT_ASSESSMENTS_TOOL: AiGatewayToolDefinition = {
  type: "function",
  function: {
    name: "submit_context_assessments",
    description: "Submit the final structured contextual assessment for every finding.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["assessments"],
      properties: {
        assessments: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "findingIndex",
              "classification",
              "fileRole",
              "environment",
              "exposureScope",
              "principalScope",
              "secretKind",
              "evidenceStrength",
              "confidence",
              "evidence",
              "benignSignals",
              "riskSignals",
              "missingEvidence",
              "reason",
            ],
            properties: {
              findingIndex: { type: "integer", minimum: 0 },
              classification: { enum: ["probable_secret", "probable_false_positive", "uncertain"] },
              fileRole: { enum: ["production_configuration", "infrastructure_as_code", "deployment_manifest", "application_code", "test_fixture", "documentation", "example", "generated_file", "unknown"] },
              environment: { enum: ["production", "staging", "development", "test", "unknown"] },
              exposureScope: { enum: ["internet_facing", "internal", "restricted", "local_only", "unknown"] },
              principalScope: { enum: ["human_user", "service_account", "application", "workload", "shared_account", "unknown"] },
              secretKind: { enum: ["cloud_credential", "database_credential", "api_token", "private_key", "password", "connection_string", "certificate", "unknown"] },
              evidenceStrength: { enum: ["strong", "moderate", "weak"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence: { type: "array", items: { type: "object" }, maxItems: 12 },
              benignSignals: { type: "array", items: { type: "string" }, maxItems: 12 },
              riskSignals: { type: "array", items: { type: "string" }, maxItems: 12 },
              missingEvidence: { type: "array", items: { type: "string" }, maxItems: 12 },
              reason: { type: "string", minLength: 1, maxLength: 1500 },
            },
          },
        },
      },
    },
  },
};

export const SUBMIT_DETECTOR_GAP_ASSESSMENTS_TOOL: AiGatewayToolDefinition = {
  type: "function",
  function: {
    name: "submit_detector_gap_assessments",
    description: "Submit generalized, review-only detector gap proposals.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["assessments"],
      properties: {
        assessments: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["findingIndex", "status", "keywords", "exclusionSuggestions", "evidence", "reason"],
            properties: {
              findingIndex: { type: "integer", minimum: 0 },
              status: { enum: ["new_detector_candidate", "existing_detector_tuning", "custom_verifier_candidate", "not_a_detector_gap", "uncertain"] },
              proposedName: { type: "string", maxLength: 100 },
              keywords: { type: "array", items: { type: "string" }, maxItems: 20 },
              secretShape: { type: "string", maxLength: 500 },
              regexTemplate: { type: "string", maxLength: 1000 },
              verificationApproach: { type: "string", maxLength: 1000 },
              exclusionSuggestions: { type: "array", items: { type: "string" }, maxItems: 20 },
              evidence: { type: "array", items: { type: "string" }, maxItems: 20 },
              reason: { type: "string", minLength: 1, maxLength: 1500 },
            },
          },
        },
      },
    },
  },
};
