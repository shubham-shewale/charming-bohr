import path from "node:path";
import pLimit from "p-limit";
import type { AppConfig } from "./config.js";
import { groupFindingsByContentIdentity, readFindingsCsv } from "./csv/reader.js";
import { writeResultsCsv } from "./csv/writer.js";
import { FileFetcher } from "./fetcher/file-fetcher.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "./trufflehog/matcher.js";
import { runTruffleHog, type RunTruffleHogOptions } from "./trufflehog/runner.js";
import {
  type CanonicalSource,
  type FindingRef,
  type FindingResult,
  buildNonPendingFindingResult,
} from "./types.js";

import { ClaudeAnalyzer, type AnthropicClientLike } from "./llm/analyzer.js";
import { CostTracker } from "./llm/cost-tracker.js";

export interface PipelineOptions {
  config: AppConfig;
  output?: string;
  retryFailed?: boolean;
  keepFiles?: boolean;
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
  anthropicClient?: AnthropicClientLike;
}

export interface PipelineSummary {
  outputPath: string;
  totalFindings: number;
  completed: number;
  verified: number;
  unverified: number;
  notFound: number;
  falsePositive: number;
  likelySecret: number;
  uncertain: number;
  llmInvalidOutput: number;
  skipped: number;
  failed: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  results: FindingResult[];
}

async function scanWithTruffleHog(
  localFilePath: string,
  findings: FindingRef[],
  execFn?: RunTruffleHogOptions["execFn"]
): Promise<FindingResult[]> {
  const detections = await runTruffleHog(localFilePath, { execFn });
  return matchDetectionsToFindings(findings, detections);
}

/**
 * Runs the end-to-end secret reconciliation pipeline.
 */
export async function runPipeline(
  inputPaths: string[],
  options: PipelineOptions
): Promise<PipelineSummary> {
  const { config } = options;

  // Determine output path
  let outputPath = options.output;
  if (!outputPath) {
    const firstInput = inputPaths[0]!;
    const dir = path.dirname(firstInput);
    const ext = path.extname(firstInput);
    const base = path.basename(firstInput, ext);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    outputPath = path.join(dir, `${base}-${timestamp}.csv`);
  }

  // Initialize file fetcher and cost tracker
  const fetcher = new FileFetcher({
    githubPat: config.githubPat,
    fetchProvider: options.fetchProvider,
  });

  const costTracker = new CostTracker();
  const claudeAnalyzer = new ClaudeAnalyzer({
    config,
    anthropicClient: options.anthropicClient,
    costTracker,
  });

  // Read all input CSV files
  const allFindings: FindingRef[] = [];
  const mergedHeadersSet = new Set<string>();

  for (const inputPath of inputPaths) {
    const { findings, headers } = await readFindingsCsv(inputPath, {
      retryFailed: options.retryFailed,
    });
    for (const h of headers) {
      mergedHeadersSet.add(h);
    }
    allFindings.push(...findings);
  }

  const mergedHeaders = Array.from(mergedHeadersSet);

  // Group pending findings by Content Identity
  const workMap = groupFindingsByContentIdentity(allFindings);

  // Setup bounded concurrency
  const limit = pLimit(config.concurrency);
  const workPromises: Promise<FindingResult[]>[] = [];

  for (const workItem of workMap.values()) {
    const task = limit(async () => {
      const sampleSource = workItem.findings[0]!.canonicalSource!;
      try {
        const localFilePath = await fetcher.fetchFile(sampleSource);

        if (config.flow === "llm-only") {
          return await claudeAnalyzer.analyzeWorkItem(workItem, localFilePath);
        } else if (config.flow === "trufflehog-only") {
          return await scanWithTruffleHog(
            localFilePath,
            workItem.findings,
            options.trufflehogExecFn
          );
        } else {
          throw new Error(`Flow "${config.flow}" is not supported yet.`);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return produceErrorResultsForWorkItem(workItem, errMsg);
      }
    });
    workPromises.push(task);
  }

  const workResultsArrays = await Promise.all(workPromises);
  const processedResultsMap = new Map<FindingRef, FindingResult>();

  for (const resArray of workResultsArrays) {
    for (const res of resArray) {
      processedResultsMap.set(res.findingRef, res);
    }
  }

  // Handle findings that were not part of any work item (skipped, already completed, or failed without retry)
  const finalResults: FindingResult[] = [];

  for (const finding of allFindings) {
    if (processedResultsMap.has(finding)) {
      finalResults.push(processedResultsMap.get(finding)!);
    } else {
      finalResults.push(buildNonPendingFindingResult(finding));
    }
  }

  // Sort final results by input file and row index
  finalResults.sort((a, b) => {
    if (a.findingRef.sourceFile !== b.findingRef.sourceFile) {
      return a.findingRef.sourceFile.localeCompare(b.findingRef.sourceFile);
    }
    return a.findingRef.rowIndex - b.findingRef.rowIndex;
  });

  // Write output CSV
  writeResultsCsv(outputPath, finalResults, mergedHeaders);

  // Cleanup temp files if configured
  const shouldKeep = options.keepFiles ?? !config.cleanupTempFiles;
  if (!shouldKeep) {
    fetcher.cleanup();
  }

  // Calculate summary stats
  let completed = 0;
  let verified = 0;
  let unverified = 0;
  let notFound = 0;
  let falsePositive = 0;
  let likelySecret = 0;
  let uncertain = 0;
  let llmInvalidOutput = 0;
  let skipped = 0;
  let failed = 0;

  for (const res of finalResults) {
    if (res.status === "completed") {
      completed++;
      if (res.trufflehogResult === "verified") verified++;
      else if (res.trufflehogResult === "unverified") unverified++;
      else if (res.trufflehogResult === "not_found") notFound++;

      if (res.llmClassification === "false_positive") falsePositive++;
      else if (res.llmClassification === "likely_secret") likelySecret++;
      else if (res.llmClassification === "uncertain") uncertain++;
    } else if (res.status === "skipped") {
      skipped++;
    } else if (res.status === "failed") {
      failed++;
      if (res.error === "llm_invalid_output") {
        llmInvalidOutput++;
      }
    }
  }

  const tokenUsage = costTracker.getUsage();

  return {
    outputPath,
    totalFindings: finalResults.length,
    completed,
    verified,
    unverified,
    notFound,
    falsePositive,
    likelySecret,
    uncertain,
    llmInvalidOutput,
    skipped,
    failed,
    tokenUsage: config.flow !== "trufflehog-only" ? tokenUsage : undefined,
    results: finalResults,
  };
}
