import fs from "node:fs";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type {
  AiGatewayClientLike,
  AiGatewayMessage,
  AiGatewayRequest,
  AiGatewayResponse,
} from "../ai-gateway/types.js";
import { OpenAiCompatibleGatewayClient } from "../ai-gateway/client.js";
import {
  type DetectorGapAssessment,
  type FileWorkItem,
  type FindingRef,
  type FindingResult,
  type SecretContextAssessment,
} from "../types.js";
import { buildNonPendingFindingResult } from "../csv/reader.js";
import { CostTracker } from "./cost-tracker.js";
import {
  assembleContextEnvelope,
  buildAdditionalContext,
  type ContextEnvelope,
} from "./context-assembler.js";
import { enforceEvidencePolicy, validateDetectorRegexProposal } from "./evidence-policy.js";
import {
  additionalContextRequestSchema,
  contextAssessmentSchema,
  detectorGapAssessmentSchema,
  GET_ADDITIONAL_FILE_CONTEXT_TOOL,
  SUBMIT_CONTEXT_ASSESSMENTS_TOOL,
  SUBMIT_DETECTOR_GAP_ASSESSMENTS_TOOL,
  submitContextAssessmentsSchema,
  submitDetectorGapAssessmentsSchema,
} from "./tools.js";
import {
  CONTEXT_CLASSIFIER_PROMPT_VERSION,
  CONTEXT_CLASSIFIER_SYSTEM_PROMPT,
} from "./prompts/context-classifier-v1.js";
import {
  DETECTOR_ADVISOR_PROMPT_VERSION,
  DETECTOR_ADVISOR_SYSTEM_PROMPT,
} from "./prompts/detector-advisor-v1.js";

export const BATCH_SIZE = 15;

/** @deprecated Test/backwards-compatibility adapter; production uses AiGatewayClientLike. */
export interface AnthropicClientLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

const legacyClassificationSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  classification: z.enum(["false_positive", "likely_secret", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const singleFindingClassificationSchema = legacyClassificationSchema;
export type SingleFindingClassification = z.infer<typeof legacyClassificationSchema>;

function legacyAssessment(item: SingleFindingClassification): z.infer<typeof contextAssessmentSchema> {
  return {
    findingIndex: item.findingIndex,
    classification:
      item.classification === "false_positive"
        ? "probable_false_positive"
        : item.classification === "likely_secret"
          ? "probable_secret"
          : "uncertain",
    fileRole: "unknown",
    environment: "unknown",
    exposureScope: "unknown",
    principalScope: "unknown",
    secretKind: "unknown",
    evidenceStrength: "weak",
    confidence: item.confidence,
    evidence: [],
    benignSignals: [],
    riskSignals: [],
    missingEvidence: ["Legacy classifier response did not provide structured evidence"],
    reason: item.reason,
  };
}

class LegacyTextClientAdapter implements AiGatewayClientLike {
  constructor(private readonly client: AnthropicClientLike) {}

  async complete(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    const system = request.messages.find((message) => message.role === "system")?.content;
    const messages = request.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system,
      messages,
    });
    const content = response.content.map((item) => item.text ?? "").join("").trim();

    let toolArguments: unknown;
    try {
      const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
      if (Array.isArray(parsed?.classifications)) {
        const assessments = (parsed.classifications as unknown[])
          .map((item: unknown) => legacyClassificationSchema.safeParse(item))
          .filter((item: z.SafeParseReturnType<unknown, SingleFindingClassification>): item is z.SafeParseSuccess<SingleFindingClassification> => item.success)
          .map((item: z.SafeParseSuccess<SingleFindingClassification>) => legacyAssessment(item.data));
        toolArguments = { assessments };
      } else {
        toolArguments = parsed;
      }
    } catch {
      toolArguments = { assessments: [] };
    }

    return {
      toolCalls: [{
        id: "legacy-final",
        name: "submit_context_assessments",
        arguments: toolArguments,
      }],
      content,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
    };
  }
}

export interface ContextualSecretAnalyzerOptions {
  config: AppConfig;
  aiGatewayClient?: AiGatewayClientLike;
  /** @deprecated Use aiGatewayClient. */
  anthropicClient?: AnthropicClientLike;
  costTracker?: CostTracker;
}

interface AnalyzerConfig {
  model: string;
  maxTokensPerRequest: number;
  maxLlmCallsPerFile: number;
  surroundingLines: number;
  maxFileSizeKb: number;
  maxContextExpansions: number;
  maxContextLines: number;
  detectorAdvisorEnabled: boolean;
}

export interface AnalyzeWorkItemOptions {
  verificationResults?: Map<FindingRef, FindingResult>;
}

export class ContextualSecretAnalyzer {
  private readonly config: AnalyzerConfig;
  private readonly client: AiGatewayClientLike;
  private readonly costTracker: CostTracker;
  private readonly legacyMode: boolean;

  constructor(options: ContextualSecretAnalyzerOptions) {
    const model = options.config.aiGatewayModel ?? options.config.anthropicModel;
    const maxTokens = options.config.maxTokensPerRequest;
    const maxCalls = options.config.maxLlmCallsPerFile;
    if (!model || maxTokens === undefined || maxCalls === undefined) {
      throw new Error("AI Gateway configuration is required for contextual classification");
    }

    this.config = {
      model,
      maxTokensPerRequest: maxTokens,
      maxLlmCallsPerFile: maxCalls,
      surroundingLines: options.config.surroundingLines,
      maxFileSizeKb: options.config.maxFileSizeKb,
      maxContextExpansions: options.config.llmMaxContextExpansions ?? 2,
      maxContextLines: options.config.llmMaxContextLines ?? 150,
      detectorAdvisorEnabled: options.config.llmDetectorAdvisorEnabled ?? false,
    };
    this.costTracker = options.costTracker ?? new CostTracker();
    this.legacyMode = Boolean(options.anthropicClient && !options.aiGatewayClient);

    if (options.aiGatewayClient) {
      this.client = options.aiGatewayClient;
    } else if (options.anthropicClient) {
      this.client = new LegacyTextClientAdapter(options.anthropicClient);
    } else {
      if (!options.config.aiGatewayUrl) {
        throw new Error("AI_GATEWAY_URL is required when no gateway client is injected");
      }
      this.client = new OpenAiCompatibleGatewayClient({
        baseUrl: options.config.aiGatewayUrl,
        authToken: options.config.aiGatewayAuthToken,
        timeoutMs: (options.config.aiGatewayTimeoutSeconds ?? 30) * 1000,
      });
    }
  }

  async analyzeWorkItem(
    workItem: FileWorkItem,
    localFilePath: string,
    options: AnalyzeWorkItemOptions = {}
  ): Promise<FindingResult[]> {
    const pending = workItem.findings.filter((finding) => finding.initialStatus === "pending");
    const nonPending = workItem.findings
      .filter((finding) => finding.initialStatus !== "pending")
      .map(buildNonPendingFindingResult);
    if (pending.length === 0) return nonPending;

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(localFilePath, "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        ...nonPending,
        ...pending.map((finding) => ({
          findingRef: finding,
          status: "failed" as const,
          error: `Failed to read fetched file: ${message}`,
        })),
      ];
    }

    const results: FindingResult[] = [...nonPending];
    let callsUsed = 0;
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const batch = pending.slice(offset, offset + BATCH_SIZE);
      if (callsUsed >= this.config.maxLlmCallsPerFile) {
        results.push(...this.invalidBatch(batch, "Max LLM calls per file exceeded", "max_llm_calls_exceeded"));
        continue;
      }
      try {
        const analyzed = await this.analyzeBatch(
          workItem,
          batch,
          fileContent,
          options.verificationResults,
          this.config.maxLlmCallsPerFile - callsUsed
        );
        callsUsed += analyzed.callsUsed;
        results.push(...analyzed.results);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        callsUsed++;
        results.push(...this.invalidBatch(batch, `AI Gateway request failed: ${message}`, "ai_gateway_error"));
      }
    }
    return results;
  }

  private invalidBatch(
    batch: FindingRef[],
    reason: string,
    error: string
  ): FindingResult[] {
    if (this.legacyMode) {
      return batch.map((finding) => ({
        findingRef: finding,
        status: "failed",
        llmReason: reason,
        error,
      }));
    }
    return batch.map((finding) => ({
      findingRef: finding,
      status: "completed",
      llmClassification: "uncertain",
      llmReason: reason,
      llmConfidence: 0,
      llmModel: this.config.model,
      llmPromptVersion: CONTEXT_CLASSIFIER_PROMPT_VERSION,
      error,
    }));
  }

  private recordUsage(response: AiGatewayResponse): void {
    if (response.usage) {
      this.costTracker.addUsage(response.usage.inputTokens, response.usage.outputTokens);
    }
  }

  private async analyzeBatch(
    workItem: FileWorkItem,
    batch: FindingRef[],
    fileContent: string,
    verificationResults: Map<FindingRef, FindingResult> | undefined,
    callBudget: number
  ): Promise<{ results: FindingResult[]; callsUsed: number }> {
    const envelopes = batch.map((finding, findingIndex) =>
      assembleContextEnvelope(
        workItem,
        finding,
        findingIndex,
        fileContent,
        verificationResults?.get(finding),
        {
          surroundingLines: this.config.surroundingLines,
          maxBytes: Math.min(this.config.maxFileSizeKb * 1024, 64 * 1024),
          maxLines: this.config.maxContextLines,
        }
      )
    );
    const legacyPrompt = `${envelopes
      .map((item) => `Finding index ${item.findingIndex}:\n- Title/Rule: ${item.ruleId}\n- Lines: ${item.lineStart} to ${item.lineEnd}`)
      .join("\n\n")}\n\nAnnotated Code Context:\n${envelopes
      .map((item) => item.redactedContext)
      .join("\n--- (next finding) ---\n")}`;
    const messages: AiGatewayMessage[] = [
      { role: "system", content: CONTEXT_CLASSIFIER_SYSTEM_PROMPT },
      {
        role: "user",
        content: this.legacyMode
          ? legacyPrompt
          : JSON.stringify({
              task: "classify_secret_context",
              repository: workItem.project
                ? `${workItem.org}/${workItem.project}/${workItem.repo}`
                : `${workItem.org}/${workItem.repo}`,
              revision: workItem.revision,
              findings: envelopes,
            }),
      },
    ];

    let callsUsed = 0;
    let expansions = 0;
    let parsedAssessments: Array<z.infer<typeof contextAssessmentSchema>> | undefined;

    while (callsUsed < callBudget) {
      const response = await this.client.complete({
        model: this.config.model,
        messages,
        tools: this.config.maxContextExpansions > 0
          ? [GET_ADDITIONAL_FILE_CONTEXT_TOOL, SUBMIT_CONTEXT_ASSESSMENTS_TOOL]
          : [SUBMIT_CONTEXT_ASSESSMENTS_TOOL],
        toolChoice: "required",
        maxTokens: this.config.maxTokensPerRequest,
      });
      callsUsed++;
      this.recordUsage(response);

      const finalCall = response.toolCalls.find((call) => call.name === "submit_context_assessments");
      if (finalCall) {
        const parsed = submitContextAssessmentsSchema.safeParse(finalCall.arguments);
        if (parsed.success) parsedAssessments = parsed.data.assessments;
        break;
      }

      const contextCall = response.toolCalls.find((call) => call.name === "get_additional_file_context");
      const parsedRequest = additionalContextRequestSchema.safeParse(contextCall?.arguments);
      if (
        !contextCall ||
        !parsedRequest.success ||
        expansions >= this.config.maxContextExpansions
      ) {
        break;
      }
      const envelope = envelopes[parsedRequest.data.findingIndex];
      if (!envelope) break;

      const maxEnd = parsedRequest.data.startLine + this.config.maxContextLines - 1;
      const safeEnd = Math.min(parsedRequest.data.endLine, maxEnd);
      const additional = buildAdditionalContext(
        fileContent,
        parsedRequest.data.startLine,
        safeEnd,
        this.config.maxContextLines
      );
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        toolCalls: [contextCall],
      });
      messages.push({
        role: "tool",
        content: JSON.stringify({
          findingIndex: parsedRequest.data.findingIndex,
          redactedContext: additional,
          truncated: safeEnd < parsedRequest.data.endLine,
        }),
        toolCallId: contextCall.id,
      });
      expansions++;
    }

    if (!parsedAssessments) {
      return {
        results: this.invalidBatch(batch, "Missing or malformed contextual assessment", "llm_invalid_output"),
        callsUsed,
      };
    }

    const assessmentMap = new Map<number, SecretContextAssessment>();
    for (const item of parsedAssessments) {
      if (item.findingIndex >= batch.length) continue;
      assessmentMap.set(
        item.findingIndex,
        this.legacyMode ? item : enforceEvidencePolicy(item)
      );
    }

    let detectorAssessments = new Map<number, DetectorGapAssessment>();
    const detectorCandidates = [...assessmentMap.entries()].filter(([index, assessment]) => {
      const finding = batch[index];
      return (
        finding !== undefined &&
        verificationResults?.get(finding)?.trufflehogResult === "not_detected" &&
        assessment.classification === "probable_secret"
      );
    });

    if (
      this.config.detectorAdvisorEnabled &&
      detectorCandidates.length > 0 &&
      callsUsed < callBudget
    ) {
      try {
        const advised = await this.runDetectorAdvisor(
          detectorCandidates.map(([index]) => envelopes[index]!),
          detectorCandidates.map(([index, assessment]) => ({ index, assessment }))
        );
        detectorAssessments = advised;
      } catch {
        // Detector advice is optional and review-only. A failed advisory call
        // must not erase an otherwise valid contextual assessment.
      } finally {
        callsUsed++;
      }
    }

    const results = batch.map((finding, index): FindingResult => {
      const assessment = assessmentMap.get(index);
      if (!assessment) {
        return this.invalidBatch([finding], "Missing contextual assessment for finding", "llm_invalid_output")[0]!;
      }
      const legacyClassification =
        assessment.classification === "probable_false_positive"
          ? "false_positive"
          : assessment.classification === "probable_secret"
            ? "likely_secret"
            : "uncertain";
      return {
        findingRef: finding,
        status: "completed",
        llmClassification: this.legacyMode ? legacyClassification : assessment.classification,
        llmReason: assessment.reason,
        llmConfidence: assessment.confidence,
        contextAssessment: assessment,
        detectorGapAssessment: detectorAssessments.get(index),
        llmModel: this.config.model,
        llmPromptVersion: detectorAssessments.has(index)
          ? `${CONTEXT_CLASSIFIER_PROMPT_VERSION}+${DETECTOR_ADVISOR_PROMPT_VERSION}`
          : CONTEXT_CLASSIFIER_PROMPT_VERSION,
        error: "",
      };
    });
    return { results, callsUsed };
  }

  private async runDetectorAdvisor(
    envelopes: ContextEnvelope[],
    candidates: Array<{ index: number; assessment: SecretContextAssessment }>
  ): Promise<Map<number, DetectorGapAssessment>> {
    const response = await this.client.complete({
      model: this.config.model,
      messages: [
        { role: "system", content: DETECTOR_ADVISOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            task: "assess_detector_gaps",
            findings: candidates.map(({ index, assessment }, offset) => ({
              findingIndex: index,
              context: envelopes[offset],
              contextAssessment: assessment,
            })),
          }),
        },
      ],
      tools: [SUBMIT_DETECTOR_GAP_ASSESSMENTS_TOOL],
      toolChoice: "required",
      maxTokens: this.config.maxTokensPerRequest,
    });
    this.recordUsage(response);
    const call = response.toolCalls.find((toolCall) => toolCall.name === "submit_detector_gap_assessments");
    const parsed = submitDetectorGapAssessmentsSchema.safeParse(call?.arguments);
    const results = new Map<number, DetectorGapAssessment>();
    if (!parsed.success) return results;

    for (const item of parsed.data.assessments) {
      if (!candidates.some((candidate) => candidate.index === item.findingIndex)) continue;
      const validated = detectorGapAssessmentSchema.parse(item);
      results.set(item.findingIndex, {
        status: validated.status,
        proposedName: validated.proposedName,
        keywords: validated.keywords,
        secretShape: validated.secretShape,
        regexTemplate: validateDetectorRegexProposal(validated.regexTemplate),
        verificationApproach: validated.verificationApproach,
        exclusionSuggestions: validated.exclusionSuggestions,
        evidence: validated.evidence,
        reason: validated.reason,
      });
    }
    return results;
  }
}

/** @deprecated Kept as a source-compatible alias for existing integrations. */
export { ContextualSecretAnalyzer as ClaudeAnalyzer };
