import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import type { AppConfig } from "./config.js";
import {
  groupFindingsByContentIdentity,
  readFindingsCsv,
  mergeHeaders,
  buildNonPendingFindingResult,
} from "./csv/reader.js";
import { writeResultsCsv } from "./csv/writer.js";
import { FileFetcher } from "./fetcher/file-fetcher.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "./trufflehog/matcher.js";
import { runTruffleHog, type RunTruffleHogOptions } from "./trufflehog/runner.js";
import {
  type CanonicalSource,
  type FindingRef,
  type FindingResult,
} from "./types.js";

import { ClaudeAnalyzer, type AnthropicClientLike } from "./llm/analyzer.js";
import { CostTracker } from "./llm/cost-tracker.js";
import { executeHybridFlow } from "./hybrid/state-machine.js";

export interface PipelineProgress {
  filesProcessed: number;
  totalFiles: number;
  findingsCompleted: number;
  totalFindings: number;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  estimatedCostUsd: number;
}

export interface PipelineOptions {
  config: AppConfig;
  output?: string;
  retryFailed?: boolean;
  keepFiles?: boolean;
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
  anthropicClient?: AnthropicClientLike;
  onProgress?: (progress: PipelineProgress) => void;
  signal?: AbortSignal;
  sigintTimeoutMs?: number;
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
  pending: number;
  interrupted?: boolean;
  tempDirKept?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  results: FindingResult[];
}

/**
 * Generates the default output filename formatted as results-{YYYYMMDD}T{HHMM}.csv in cwd.
 */
export function generateDefaultOutputFilename(
  cwd: string = process.cwd(),
  now: Date = new Date()
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return path.join(cwd, `results-${yyyy}${mm}${dd}T${hh}${min}.csv`);
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
    outputPath = generateDefaultOutputFilename();
  }

  // Initialize file fetcher and cost tracker
  const fetcher = new FileFetcher({
    githubPat: config.githubPat,
    azureDevOpsPat: config.azureDevOpsPat,
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
  const inputHeadersList: string[][] = [];

  for (const inputPath of inputPaths) {
    const { findings, headers } = await readFindingsCsv(inputPath, {
      retryFailed: options.retryFailed,
    });
    inputHeadersList.push(headers);
    allFindings.push(...findings);
  }

  const mergedHeaders = mergeHeaders(...inputHeadersList);

  // Group pending findings by Content Identity
  const workMap = groupFindingsByContentIdentity(allFindings);

  // Setup bounded concurrency and cancellation tracking
  const limit = pLimit(config.concurrency);
  const timeoutMs = options.sigintTimeoutMs ?? 2000;
  let isAborted = options.signal?.aborted ?? false;
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      isAborted = true;
    });
  }

  const processedResultsMap = new Map<FindingRef, FindingResult>();
  let filesProcessed = 0;
  let findingsCompleted = allFindings.filter((f) => f.initialStatus === "completed").length;
  const totalFiles = workMap.size;
  const totalFindings = allFindings.length;

  const reportProgress = () => {
    if (options.onProgress) {
      const usage = costTracker.getUsage();
      options.onProgress({
        filesProcessed,
        totalFiles,
        findingsCompleted,
        totalFindings,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        tokensUsed: usage.inputTokens + usage.outputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      });
    }
  };

  // Initial progress notification
  reportProgress();

  const workItemExecutors = Array.from(workMap.values()).map((workItem) => {
    return async () => {
      if (isAborted) {
        return;
      }

      try {
        const sampleSource = workItem.findings[0]!.canonicalSource!;
        const localFilePath = await fetcher.fetchFile(sampleSource);

        // Check file size against MAX_FILE_SIZE_KB
        const stats = fs.statSync(localFilePath);
        const maxBytes = config.maxFileSizeKb * 1024;
        let results: FindingResult[];

        if (stats.size > maxBytes) {
          const sizeKb = (stats.size / 1024).toFixed(1);
          const errMsg = `File size (${sizeKb} KB) exceeds MAX_FILE_SIZE_KB limit of ${config.maxFileSizeKb} KB`;
          results = workItem.findings.map((finding) => ({
            findingRef: finding,
            status: "skipped" as const,
            error: errMsg,
          }));
        } else if (config.flow === "llm-only") {
          results = await claudeAnalyzer.analyzeWorkItem(workItem, localFilePath);
        } else if (config.flow === "trufflehog-only") {
          results = await scanWithTruffleHog(
            localFilePath,
            workItem.findings,
            options.trufflehogExecFn
          );
        } else if (config.flow === "hybrid") {
          results = await executeHybridFlow(workItem, localFilePath, {
            claudeAnalyzer,
            trufflehogExecFn: options.trufflehogExecFn,
          });
        } else {
          throw new Error(`Flow "${config.flow}" is not supported yet.`);
        }

        for (const res of results) {
          processedResultsMap.set(res.findingRef, res);
        }

        filesProcessed++;
        for (const res of results) {
          if (res.status === "completed") findingsCompleted++;
        }
        reportProgress();
      } catch (err: unknown) {
        if (!isAborted) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errResults = produceErrorResultsForWorkItem(workItem, errMsg);
          for (const res of errResults) {
            processedResultsMap.set(res.findingRef, res);
          }
          filesProcessed++;
          reportProgress();
        }
      }
    };
  });

  const executionPromise = Promise.all(workItemExecutors.map((execute) => limit(execute)));

  if (options.signal) {
    const abortTriggeredPromise = new Promise<void>((resolve) => {
      if (options.signal!.aborted) {
        resolve();
      } else {
        options.signal!.addEventListener("abort", () => resolve(), { once: true });
      }
    });

    await Promise.race([
      executionPromise,
      abortTriggeredPromise.then(async () => {
        isAborted = true;
        // Wait up to timeoutMs for in-flight work items to finish
        await Promise.race([
          executionPromise,
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
      }),
    ]);
  } else {
    await executionPromise;
  }

  // Build final results array
  const finalResults: FindingResult[] = [];

  for (const finding of allFindings) {
    if (processedResultsMap.has(finding)) {
      finalResults.push(processedResultsMap.get(finding)!);
    } else if (finding.initialStatus === "pending") {
      finalResults.push({
        findingRef: finding,
        status: "pending",
        error: "",
      });
    } else {
      finalResults.push(buildNonPendingFindingResult(finding));
    }
  }

  // Write output CSV atomically
  writeResultsCsv(outputPath, finalResults, mergedHeaders);

  // Cleanup temp files if configured
  const shouldKeep = options.keepFiles === true || !config.cleanupTempFiles;
  let tempDirKept: string | undefined;
  if (!shouldKeep) {
    fetcher.cleanup();
  } else {
    tempDirKept = fetcher.getTempDir();
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
  let pending = 0;

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
    } else if (res.status === "pending") {
      pending++;
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
    pending,
    interrupted: isAborted,
    tempDirKept,
    tokenUsage: config.flow !== "trufflehog-only" ? tokenUsage : undefined,
    results: finalResults,
  };
}
