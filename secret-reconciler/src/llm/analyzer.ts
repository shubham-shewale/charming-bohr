import fs from "node:fs";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { buildCodeContext } from "./context-builder.js";
import { CostTracker } from "./cost-tracker.js";
import {
  type FileWorkItem,
  type FindingResult,
} from "../types.js";
import { buildNonPendingFindingResult } from "../csv/reader.js";

export const BATCH_SIZE = 15;

/**
 * Minimal interface for Anthropic client to allow easy mocking in tests.
 */
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

/**
 * Zod schema for validating individual LLM finding classification.
 */
export const singleFindingClassificationSchema = z.object({
  findingIndex: z.number().int(),
  classification: z.enum(["false_positive", "likely_secret", "uncertain"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type SingleFindingClassification = z.infer<typeof singleFindingClassificationSchema>;

const llmBatchResponseSchema = z.object({
  classifications: z.array(z.unknown()),
});

export interface ClaudeAnalyzerOptions {
  config: AppConfig;
  anthropicClient?: AnthropicClientLike;
  costTracker?: CostTracker;
}

export class ClaudeAnalyzer {
  private config: AppConfig;
  private client: AnthropicClientLike;
  private costTracker: CostTracker;

  constructor(options: ClaudeAnalyzerOptions) {
    this.config = options.config;
    this.costTracker = options.costTracker ?? new CostTracker();

    if (options.anthropicClient) {
      this.client = options.anthropicClient;
    } else {
      this.client = new Anthropic({
        apiKey: this.config.anthropicApiKey,
      });
    }
  }

  /**
   * Analyzes all pending findings in a FileWorkItem using Claude.
   */
  public async analyzeWorkItem(
    workItem: FileWorkItem,
    localFilePath: string
  ): Promise<FindingResult[]> {
    const pendingFindings = workItem.findings.filter((f) => f.initialStatus === "pending");
    const nonPendingResults: FindingResult[] = workItem.findings
      .filter((f) => f.initialStatus !== "pending")
      .map(buildNonPendingFindingResult);

    if (pendingFindings.length === 0) {
      return nonPendingResults;
    }

    // Read local file content
    let fileContent = "";
    try {
      fileContent = fs.readFileSync(localFilePath, "utf-8");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errorResults: FindingResult[] = pendingFindings.map((f) => ({
        findingRef: f,
        status: "failed",
        error: `Failed to read fetched file: ${errMsg}`,
      }));
      return [...nonPendingResults, ...errorResults];
    }

    // Split pending findings into batches of BATCH_SIZE (15)
    const batches: (typeof pendingFindings)[] = [];
    for (let i = 0; i < pendingFindings.length; i += BATCH_SIZE) {
      batches.push(pendingFindings.slice(i, i + BATCH_SIZE));
    }

    const results: FindingResult[] = [...nonPendingResults];
    const maxCalls = this.config.maxLlmCallsPerFile;

    for (let bIndex = 0; bIndex < batches.length; bIndex++) {
      const batch = batches[bIndex]!;

      // Enforce MAX_LLM_CALLS_PER_FILE limit
      if (bIndex >= maxCalls) {
        for (const f of batch) {
          results.push({
            findingRef: f,
            status: "failed",
            llmReason: "Max LLM calls per file exceeded",
            error: "max_llm_calls_exceeded",
          });
        }
        continue;
      }

      const batchResults = await this.analyzeBatch(workItem, batch, fileContent);
      results.push(...batchResults);
    }

    return results;
  }

  private failBatch(
    batch: FileWorkItem["findings"],
    llmReason: string,
    error: string
  ): FindingResult[] {
    return batch.map((f) => ({
      findingRef: f,
      status: "failed",
      llmReason,
      error,
    }));
  }

  private async analyzeBatch(
    workItem: FileWorkItem,
    batch: FileWorkItem["findings"],
    fileContent: string
  ): Promise<FindingResult[]> {
    const getTitle = (rawRow: Record<string, string>, fallback: string): string => {
      for (const [key, val] of Object.entries(rawRow)) {
        const norm = key.trim().toLowerCase().replace(/[\s_]+/g, "");
        if (norm === "ruleid" || norm === "checkid" || norm === "title" || norm === "findingtitle" || norm === "policyid") {
          if (val && val.trim()) return val.trim();
        }
      }
      return fallback;
    };

    // Build line ranges and prompt list in a single pass
    const lineRanges: Array<{ lineStart: number; lineEnd: number; title: string }> = [];
    const promptEntries: string[] = [];

    for (let idx = 0; idx < batch.length; idx++) {
      const f = batch[idx]!;
      const c = f.canonicalSource;
      const start = c?.lineStart ?? 1;
      const end = c?.lineEnd ?? 1;
      const rule = getTitle(f.rawRow, `Finding ${idx}`);

      lineRanges.push({
        lineStart: start,
        lineEnd: end,
        title: rule,
      });

      promptEntries.push(`Finding index ${idx}:
- Title/Rule: ${rule}
- Lines: ${start} to ${end}`);
    }

    const contextResult = buildCodeContext(fileContent, lineRanges, {
      surroundingLines: this.config.surroundingLines,
      maxBytes: this.config.maxFileSizeKb * 1024,
    });

    const findingsPromptList = promptEntries.join("\n\n");

    const systemPrompt = `You are an expert application security engineer auditing potential hardcoded secrets in source code.
Analyze each finding listed in the prompt within the provided code context.

For each finding, classify it into one of these three exact values:
- "false_positive": Mock data, dummy keys, test tokens, documentation samples, or standard code non-secrets.
- "likely_secret": Real API keys, credentials, high-entropy secrets, or private keys.
- "uncertain": Insufficient context to decide with confidence.

You MUST respond with ONLY a valid JSON object in the following format:
{
  "classifications": [
    {
      "findingIndex": 0,
      "classification": "false_positive" | "likely_secret" | "uncertain",
      "confidence": 0.95,
      "reason": "Detailed explanation for classification"
    }
  ]
}`;

    const repoDisplay = workItem.project
      ? `${workItem.org}/${workItem.project}/${workItem.repo}`
      : `${workItem.org}/${workItem.repo}`;

    const userPrompt = `Repository: ${repoDisplay}
File Path: ${workItem.filePath}
Revision: ${workItem.revision}

Findings to analyze:
${findingsPromptList}

Annotated Code Context:
${contextResult.formattedContext}`;

    try {
      const response = await this.client.messages.create({
        model: this.config.anthropicModel,
        max_tokens: this.config.maxTokensPerRequest,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      if (response.usage) {
        this.costTracker.addUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      const responseText = response.content
        .map((c) => c.text ?? "")
        .join("")
        .trim();

      return this.parseAndValidateResponse(batch, responseText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.failBatch(batch, `LLM request failed: ${errMsg}`, "llm_invalid_output");
    }
  }

  private parseAndValidateResponse(
    batch: FileWorkItem["findings"],
    responseText: string
  ): FindingResult[] {
    let jsonParsed: unknown;
    try {
      // Clean possible markdown code fences (e.g. ```json ... ```)
      const cleanJson = responseText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      jsonParsed = JSON.parse(cleanJson);
    } catch {
      // Complete JSON parse failure for batch
      return this.failBatch(
        batch,
        "Failed to parse JSON response from LLM",
        "llm_invalid_output"
      );
    }

    const batchParsed = llmBatchResponseSchema.safeParse(jsonParsed);
    if (!batchParsed.success) {
      return this.failBatch(
        batch,
        "Response does not match expected classifications structure",
        "llm_invalid_output"
      );
    }

    // Map each finding in the batch by its index
    const resultsMap = new Map<number, SingleFindingClassification>();
    for (const item of batchParsed.data.classifications) {
      const parsed = singleFindingClassificationSchema.safeParse(item);
      if (parsed.success) {
        resultsMap.set(parsed.data.findingIndex, parsed.data);
      }
    }

    // Handle partial batch failure
    return batch.map((f, idx) => {
      const item = resultsMap.get(idx);
      if (item) {
        return {
          findingRef: f,
          status: "completed",
          llmClassification: item.classification,
          llmReason: item.reason,
          llmConfidence: item.confidence,
          error: "",
        };
      }

      // Invalid output for this specific finding
      return {
        findingRef: f,
        status: "failed",
        llmReason: "Missing or malformed classification in LLM response",
        error: "llm_invalid_output",
      };
    });
  }
}
