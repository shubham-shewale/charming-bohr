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
import { GitHubRateLimitError } from "./providers/github-provider.js";
import { TokenPool } from "./providers/token-pool.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "./trufflehog/matcher.js";
import { runTruffleHog, type RunTruffleHogOptions } from "./trufflehog/runner.js";
import {
  type CanonicalSource,
  type FileWorkItem,
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
  /** Directory to store fetched files in. Defaults to `tmp/` in current working directory. */
  tempDir?: string;
  /** Override sleep function for testing. Defaults to setTimeout-based sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface PipelineSummary {
  outputPath: string;
  totalFindings: number;
  matchedCheckIds: number;
  selectedFindings: number;
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
  trufflehogOptions?: RunTruffleHogOptions
): Promise<FindingResult[]> {
  const detections = await runTruffleHog(localFilePath, trufflehogOptions);
  return matchDetectionsToFindings(findings, detections);
}

/**
 * Runs one pass of the p-limit executor over the given work items.
 * Returns items that were deferred due to GitHub rate limiting.
 */
async function runPass(
  workItems: FileWorkItem[],
  {
    limit,
    isAborted,
    tokenPool,
    fetcher,
    config,
    claudeAnalyzer,
    trufflehogOptions,
    processedResultsMap,
    onFileDone,
  }: {
    limit: ReturnType<typeof pLimit>;
    isAborted: () => boolean;
    tokenPool: TokenPool;
    fetcher: FileFetcher;
    config: AppConfig;
    claudeAnalyzer: ClaudeAnalyzer;
    trufflehogOptions: RunTruffleHogOptions;
    processedResultsMap: Map<FindingRef, FindingResult>;
    onFileDone: (results: FindingResult[]) => void;
  }
): Promise<FileWorkItem[]> {
  const deferred: FileWorkItem[] = [];

  const executors = workItems.map((workItem) => {
    return async () => {
      if (isAborted()) return;

      // ── isBlocked pre-check: defer immediately without a network call ─────
      if (workItem.provider === "github" && tokenPool.isBlocked) {
        deferred.push(workItem);
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
            trufflehogOptions
          );
        } else if (config.flow === "hybrid") {
          results = await executeHybridFlow(workItem, localFilePath, {
            claudeAnalyzer,
            trufflehogOptions,
          });
        } else {
          throw new Error(`Flow "${config.flow}" is not supported yet.`);
        }

        onFileDone(results);
        for (const res of results) {
          processedResultsMap.set(res.findingRef, res);
        }
      } catch (err: unknown) {
        if (err instanceof GitHubRateLimitError) {
          // Rate-limit hit mid-fetch: defer this item for the next pass
          // (Token usage and reset time have already been recorded by FileFetcher)
          deferred.push(workItem);
          return;
        }

        if (!isAborted()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errResults = produceErrorResultsForWorkItem(workItem, errMsg);
          onFileDone(errResults);
          for (const res of errResults) {
            processedResultsMap.set(res.findingRef, res);
          }
        }
      }
    };
  });

  await Promise.all(executors.map((execute) => limit(execute)));
  return deferred;
}

/**
 * Runs the end-to-end secret reconciliation pipeline.
 */
export async function runPipeline(
  sourceFiles: string[],
  options: PipelineOptions
): Promise<PipelineSummary> {
  const { config } = options;

  // Assemble TruffleHog runner options
  const trufflehogOptions: RunTruffleHogOptions = {
    execFn: options.trufflehogExecFn,
    verificationMode: config.trufflehogVerificationMode,
    userAgentSuffix: config.trufflehogUserAgentSuffix,
    timeoutMs: config.trufflehogTimeoutSeconds * 1000,
  };

  // Determine output path
  let outputPath = options.output;
  if (!outputPath) {
    outputPath = generateDefaultOutputFilename();
  }

  // Initialize TokenPool and FileFetcher
  const tokenPool = new TokenPool(config.githubPats);
  const fetcher = new FileFetcher({
    tokenPool,
    azureDevOpsPat: config.azureDevOpsPat,
    tempDir: options.tempDir,
    fetchProvider: options.fetchProvider,
  });

  const costTracker = new CostTracker();
  const claudeAnalyzer = new ClaudeAnalyzer({
    config,
    anthropicClient: options.anthropicClient,
    costTracker,
  });

  // Sleep function (overridable for testing)
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Read all source CSV files
  const allFindings: FindingRef[] = [];
  const sourceFileHeadersList: string[][] = [];

  for (const sourceFile of sourceFiles) {
    const { findings, headers } = await readFindingsCsv(sourceFile, {
      retryFailed: options.retryFailed,
    });
    sourceFileHeadersList.push(headers);
    allFindings.push(...findings);
  }

  const mergedHeaders = mergeHeaders(...sourceFileHeadersList);

  // ── Evaluate Check ID filtering and finding limits ────────────────────────
  const normalizedCheckIds =
    config.checkIds && config.checkIds.length > 0
      ? new Set(config.checkIds.map((id) => id.trim().toLowerCase()))
      : undefined;

  const isCheckIdMatch = (finding: FindingRef): boolean => {
    if (!normalizedCheckIds) return true;
    if (!finding.checkId) return false;
    return normalizedCheckIds.has(finding.checkId.trim().toLowerCase());
  };

  // 1. Filter findings matching active Check IDs
  const matchedFindings = allFindings.filter(isCheckIdMatch);
  const matchedCheckIds = matchedFindings.length;

  // 2. Select up to LIMIT pending findings from matched findings
  const candidatePendingFindings = matchedFindings.filter(
    (f) => f.initialStatus === "pending"
  );

  const selectedPendingFindings =
    config.limit !== undefined && config.limit > 0
      ? candidatePendingFindings.slice(0, config.limit)
      : candidatePendingFindings;

  const selectedFindings = selectedPendingFindings.length;

  // Group only selected pending findings by Content Identity
  const workMap = groupFindingsByContentIdentity(selectedPendingFindings);

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

  const onFileDone = (results: FindingResult[]) => {
    for (const res of results) {
      if (res.status === "completed") findingsCompleted++;
    }
    filesProcessed++;
    reportProgress();
  };

  // Initial progress notification
  reportProgress();

  // ── Main pass + defer-and-revisit loop ────────────────────────────────────

  const passArgs = {
    limit,
    isAborted: () => isAborted,
    tokenPool,
    fetcher,
    config,
    claudeAnalyzer,
    trufflehogOptions,
    processedResultsMap,
    onFileDone,
  };

  let pendingItems = Array.from(workMap.values());
  let deferredItems: FileWorkItem[] = [];

  // Handle abort signal for the first pass
  if (options.signal) {
    const abortPromise = new Promise<void>((resolve) => {
      if (options.signal!.aborted) {
        resolve();
      } else {
        options.signal!.addEventListener("abort", () => resolve(), { once: true });
      }
    });

    const firstPassPromise = runPass(pendingItems, passArgs);

    await Promise.race([
      firstPassPromise.then((d) => { deferredItems = d; }),
      abortPromise.then(async () => {
        isAborted = true;
        await Promise.race([
          firstPassPromise,
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
      }),
    ]);
  } else {
    deferredItems = await runPass(pendingItems, passArgs);
  }

  // Defer-and-revisit loop for deferred GitHub items
  const maxRetries = config.githubRateLimitMaxRetries;
  let retryPass = 0;

  if (deferredItems.length > 0) {
    const earliestReset = tokenPool.getEarliestReset();
    const resetTime = earliestReset > 0 ? new Date(earliestReset * 1000).toISOString() : "unknown";
    console.log(
      `GitHub rate limit hit — deferred ${deferredItems.length} items, retrying after reset at ${resetTime}`
    );
  }

  while (deferredItems.length > 0 && retryPass < maxRetries && !isAborted) {
    const earliestReset = tokenPool.getEarliestReset();
    const nowSeconds = Date.now() / 1000;
    const sleepSeconds = Math.max(0, earliestReset - nowSeconds + 1);
    const resetTime = earliestReset > 0 ? new Date(earliestReset * 1000).toISOString() : "unknown";

    if (retryPass > 0) {
      console.log(
        `GitHub rate limit hit — deferred ${deferredItems.length} items, retrying after reset at ${resetTime}`
      );
    }
    console.log(`Sleeping ${Math.ceil(sleepSeconds)}s until GitHub rate limit resets...`);

    await sleepFn(sleepSeconds * 1000);
    tokenPool.resetBlockedState();

    retryPass++;
    const deferredBatch = deferredItems;
    deferredItems = await runPass(deferredBatch, passArgs);
  }

  // Any items still deferred after all retries are marked failed
  if (deferredItems.length > 0) {
    const errMsg = `GitHub rate limit exceeded after ${maxRetries} retr${maxRetries === 1 ? "y" : "ies"}`;
    for (const workItem of deferredItems) {
      const errResults = produceErrorResultsForWorkItem(workItem, errMsg);
      for (const res of errResults) {
        processedResultsMap.set(res.findingRef, res);
      }
    }
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
    matchedCheckIds,
    selectedFindings,
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
