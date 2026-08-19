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
import { TokenPool, TokenPoolExhaustedError } from "./providers/token-pool.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "./trufflehog/matcher.js";
import {
  assertSupportedTruffleHogVersion,
  runTruffleHog,
  type RunTruffleHogOptions,
} from "./trufflehog/runner.js";
import {
  type CanonicalSource,
  type FileWorkItem,
  type FindingRef,
  type FindingResult,
} from "./types.js";

import { ContextualSecretAnalyzer, type AnthropicClientLike } from "./llm/analyzer.js";
import type { AiGatewayClientLike } from "./ai-gateway/types.js";
import { CostTracker } from "./llm/cost-tracker.js";
import {
  evaluateLlmFileEligibility,
  type LlmFileEligibility,
} from "./llm/eligibility.js";
import { executeHybridFlow } from "./hybrid/state-machine.js";

export interface PipelineProgress {
  filesProcessed: number;
  totalFiles: number;
  findingsProcessed: number;
  findingsCompleted: number;
  findingsSkipped: number;
  findingsFailed: number;
  totalFindings: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  llmCalls: number;
  usageReportedCalls: number;
  cacheReportedCalls: number;
  tokensUsed: number;
  estimatedCostUsd?: number;
}

export interface PipelineOptions {
  config: AppConfig;
  output?: string;
  retryFailed?: boolean;
  keepFiles?: boolean;
  fetchProvider?: (source: CanonicalSource, signal?: AbortSignal) => Promise<string>;
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
  anthropicClient?: AnthropicClientLike;
  aiGatewayClient?: AiGatewayClientLike;
  onProgress?: (progress: PipelineProgress) => void;
  signal?: AbortSignal;
  sigintTimeoutMs?: number;
  /** Directory to store fetched files in. Defaults to an isolated run directory under `tmp/`. */
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
  unknown: number;
  notDetected: number;
  ambiguous: number;
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
    cachedInputTokens: number;
    llmCalls: number;
    usageReportedCalls: number;
    cacheReportedCalls: number;
    estimatedCostUsd?: number;
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

/** Atomically reserves a default output path, suffixing only on a collision. */
export function reserveDefaultOutputFilename(
  cwd: string = process.cwd(),
  now: Date = new Date()
): string {
  const basePath = generateDefaultOutputFilename(cwd, now);
  const extension = path.extname(basePath);
  const stem = basePath.slice(0, -extension.length);

  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? basePath : `${stem}-${attempt}${extension}`;
    try {
      const descriptor = fs.openSync(candidate, "wx");
      fs.closeSync(descriptor);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function scanWithTruffleHog(
  localFilePath: string,
  findings: FindingRef[],
  trufflehogOptions?: RunTruffleHogOptions
): Promise<FindingResult[]> {
  const detections = await runTruffleHog(localFilePath, trufflehogOptions);
  return matchDetectionsToFindings(findings, detections);
}

function produceLlmPolicySkippedResults(
  workItem: FileWorkItem,
  reason: string
): FindingResult[] {
  return workItem.findings.map((finding) => ({
    findingRef: finding,
    status: "skipped",
    error: `LLM analysis skipped by policy: ${reason}`,
  }));
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
    acceptResults,
    tokenPool,
    fetcher,
    config,
    contextualAnalyzer,
    trufflehogOptions,
    processedResultsMap,
    onFileDone,
  }: {
    limit: ReturnType<typeof pLimit>;
    isAborted: () => boolean;
    acceptResults: () => boolean;
    tokenPool: TokenPool;
    fetcher: FileFetcher;
    config: AppConfig;
    contextualAnalyzer?: ContextualSecretAnalyzer;
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
        let results: FindingResult[];
        const pathEligibility = evaluateLlmFileEligibility(
          sampleSource.filePath,
          undefined,
          config.maxFileSizeKb,
          config.llmIgnorePatterns
        );

        // In llm-only mode an ignored path never needs to be fetched. Hybrid
        // still fetches and scans it with TruffleHog before skipping only LLM.
        if (config.flow === "llm-only" && !pathEligibility.eligible) {
          results = produceLlmPolicySkippedResults(workItem, pathEligibility.reason!);
        } else {
          const localFilePath = await fetcher.fetchFile(sampleSource);
          const llmEligibility: LlmFileEligibility = config.flow === "trufflehog-only"
            ? { eligible: true }
            : evaluateLlmFileEligibility(
                sampleSource.filePath,
                fs.statSync(localFilePath).size,
                config.maxFileSizeKb,
                config.llmIgnorePatterns
              );

          if (config.flow === "llm-only") {
            if (!llmEligibility.eligible) {
              results = produceLlmPolicySkippedResults(workItem, llmEligibility.reason!);
            } else {
              if (!contextualAnalyzer) {
                throw new Error("LLM analyzer is not configured for llm-only flow");
              }
              results = await contextualAnalyzer.analyzeWorkItem(workItem, localFilePath, {
                signal: trufflehogOptions.signal,
              });
            }
          } else if (config.flow === "trufflehog-only") {
            results = await scanWithTruffleHog(
              localFilePath,
              workItem.findings,
              trufflehogOptions
            );
          } else if (config.flow === "hybrid") {
            const llmSkipReason = contextualAnalyzer && !llmEligibility.eligible
              ? `LLM analysis skipped by policy: ${llmEligibility.reason}`
              : undefined;
            results = await executeHybridFlow(workItem, localFilePath, {
              contextualAnalyzer: llmEligibility.eligible ? contextualAnalyzer : undefined,
              trufflehogOptions,
              signal: trufflehogOptions.signal,
              llmSkipReason,
            });
          } else {
            throw new Error(`Flow "${config.flow}" is not supported yet.`);
          }
        }

        if (!acceptResults()) return;
        onFileDone(results);
        for (const res of results) {
          processedResultsMap.set(res.findingRef, res);
        }
      } catch (err: unknown) {
        if (err instanceof GitHubRateLimitError || err instanceof TokenPoolExhaustedError) {
          // Rate-limit hit mid-fetch: defer this item for the next pass
          // (Token usage and reset time have already been recorded by FileFetcher)
          if (acceptResults()) deferred.push(workItem);
          return;
        }

        if (!isAborted() && acceptResults()) {
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
  const hardAbortController = new AbortController();
  const timeoutMs = options.sigintTimeoutMs ?? 2000;
  let isAborted = options.signal?.aborted ?? false;
  const abortPromise = options.signal
    ? new Promise<void>((resolve) => {
        if (options.signal!.aborted) resolve();
        else options.signal!.addEventListener("abort", () => resolve(), { once: true });
      })
    : undefined;
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      isAborted = true;
    }, { once: true });
  }

  // Assemble TruffleHog runner options
  const trufflehogOptions: RunTruffleHogOptions = {
    execFn: options.trufflehogExecFn,
    verificationMode: config.trufflehogVerificationMode,
    userAgentSuffix: config.trufflehogUserAgentSuffix,
    configPath: config.trufflehogConfigPath,
    timeoutMs: config.trufflehogTimeoutSeconds * 1000,
    signal: hardAbortController.signal,
  };

  // Validate the real CLI once at startup. Test executors are explicit contract
  // doubles and are validated independently by runner unit tests.
  if (config.flow !== "llm-only" && !options.trufflehogExecFn) {
    await assertSupportedTruffleHogVersion({
      timeoutMs: config.trufflehogTimeoutSeconds * 1000,
      signal: options.signal,
    });
  }

  // An implicit output path is reserved immediately before the atomic write.
  let outputPath = options.output;

  // Initialize TokenPool and FileFetcher
  const tokenPool = new TokenPool(config.githubPats);
  const fetcher = new FileFetcher({
    tokenPool,
    azureDevOpsPat: config.azureDevOpsPat,
    tempDir: options.tempDir,
    fetchProvider: options.fetchProvider,
    signal: hardAbortController.signal,
  });

  const costTracker = new CostTracker({
    inputCostPerMillionUsd: config.aiGatewayInputCostPerMillionUsd,
    outputCostPerMillionUsd: config.aiGatewayOutputCostPerMillionUsd,
    cachedInputCostPerMillionUsd: config.aiGatewayCachedInputCostPerMillionUsd,
  });
  const contextualAnalyzer = config.flow === "trufflehog-only" || config.llmContextClassifierEnabled === false
    ? undefined
    : new ContextualSecretAnalyzer({
        config,
        aiGatewayClient: options.aiGatewayClient,
        anthropicClient: options.anthropicClient,
        costTracker,
      });

  // Sleep function (overridable for testing)
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (options.signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, ms);
    options.signal?.addEventListener("abort", finish, { once: true });
  }));

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
  let acceptResults = true;
  let unfinishedPass: Promise<FileWorkItem[]> | undefined;

  const processedResultsMap = new Map<FindingRef, FindingResult>();
  let filesProcessed = 0;
  let findingsCompleted = allFindings.filter((f) => f.initialStatus === "completed").length;
  let findingsSkipped = allFindings.filter((f) => f.initialStatus === "skipped").length;
  let findingsFailed = allFindings.filter((f) => f.initialStatus === "failed").length;
  const totalFiles = workMap.size;
  const totalFindings = allFindings.length;

  const reportProgress = () => {
    if (options.onProgress) {
      const usage = costTracker.getUsage();
      try {
        options.onProgress({
          filesProcessed,
          totalFiles,
          findingsProcessed: findingsCompleted + findingsSkipped + findingsFailed,
          findingsCompleted,
          findingsSkipped,
          findingsFailed,
          totalFindings,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          llmCalls: usage.llmCalls,
          usageReportedCalls: usage.usageReportedCalls,
          cacheReportedCalls: usage.cacheReportedCalls,
          tokensUsed: usage.inputTokens + usage.outputTokens,
          estimatedCostUsd: usage.estimatedCostUsd,
        });
      } catch {
        // Progress is observational and must never change reconciliation results.
      }
    }
  };

  const onFileDone = (results: FindingResult[]) => {
    for (const res of results) {
      if (res.status === "completed") findingsCompleted++;
      else if (res.status === "skipped") findingsSkipped++;
      else if (res.status === "failed") findingsFailed++;
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
    acceptResults: () => acceptResults,
    tokenPool,
    fetcher,
    config,
    contextualAnalyzer,
    trufflehogOptions,
    processedResultsMap,
    onFileDone,
  };

  const pendingItems = Array.from(workMap.values());
  let deferredItems: FileWorkItem[] = [];

  const runCancellablePass = async (items: FileWorkItem[]): Promise<FileWorkItem[]> => {
    const passPromise = runPass(items, passArgs);
    if (!abortPromise) return await passPromise;

    const firstOutcome = await Promise.race([
      passPromise.then((deferred) => ({ type: "completed" as const, deferred })),
      abortPromise.then(() => ({ type: "aborted" as const })),
    ]);
    if (firstOutcome.type === "completed") return firstOutcome.deferred;

    let graceTimer: NodeJS.Timeout | undefined;
    const graceOutcome = await Promise.race([
      passPromise.then((deferred) => ({ type: "completed" as const, deferred })),
      new Promise<{ type: "timeout" }>((resolve) => {
        graceTimer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (graceOutcome.type === "completed") return graceOutcome.deferred;

    acceptResults = false;
    hardAbortController.abort();
    unfinishedPass = passPromise;
    return [];
  };

  deferredItems = await runCancellablePass(pendingItems);

  // Defer-and-revisit loop for deferred GitHub items
  const maxRetries = config.githubRateLimitMaxRetries;
  let retryPass = 0;

  if (deferredItems.length > 0) {
    const earliestReset = tokenPool.getEarliestReset();
    const resetTime = earliestReset > 0 ? new Date(earliestReset * 1000).toISOString() : "unknown";
    console.log(`[warn] event=github_rate_limit deferred=${deferredItems.length} reset=${resetTime}`);
  }

  while (deferredItems.length > 0 && retryPass < maxRetries && !isAborted) {
    const earliestReset = tokenPool.getEarliestReset();
    const nowSeconds = Date.now() / 1000;
    const sleepSeconds = Math.max(0, earliestReset - nowSeconds + 1);
    const resetTime = earliestReset > 0 ? new Date(earliestReset * 1000).toISOString() : "unknown";

    if (retryPass > 0) {
      console.log(`[warn] event=github_rate_limit deferred=${deferredItems.length} reset=${resetTime}`);
    }
    console.log(`[wait] event=github_rate_limit seconds=${Math.ceil(sleepSeconds)} reset=${resetTime}`);

    if (abortPromise) {
      await Promise.race([sleepFn(sleepSeconds * 1000), abortPromise]);
    } else {
      await sleepFn(sleepSeconds * 1000);
    }
    if (isAborted) break;
    tokenPool.resetBlockedState();

    retryPass++;
    const deferredBatch = deferredItems;
    deferredItems = await runCancellablePass(deferredBatch);
  }

  // Any items still deferred after all retries are marked failed
  if (deferredItems.length > 0 && !isAborted) {
    const errMsg = `GitHub rate limit exceeded after ${maxRetries} retr${maxRetries === 1 ? "y" : "ies"}`;
    for (const workItem of deferredItems) {
      const errResults = produceErrorResultsForWorkItem(workItem, errMsg);
      onFileDone(errResults);
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

  // Reserve an implicit destination only when the output is ready to be written.
  outputPath ??= reserveDefaultOutputFilename();

  // Write output CSV atomically
  writeResultsCsv(outputPath, finalResults, mergedHeaders);

  // Cleanup temp files if configured
  const shouldKeep = options.keepFiles === true || !config.cleanupTempFiles;
  let tempDirKept: string | undefined;
  if (!shouldKeep) {
    if (unfinishedPass) {
      void unfinishedPass.then(
        () => fetcher.cleanup(),
        () => fetcher.cleanup()
      );
    } else {
      fetcher.cleanup();
    }
  } else {
    tempDirKept = fetcher.getTempDir();
  }

  // Calculate summary stats
  let completed = 0;
  let verified = 0;
  let unverified = 0;
  let unknown = 0;
  let notDetected = 0;
  let ambiguous = 0;
  let falsePositive = 0;
  let likelySecret = 0;
  let uncertain = 0;
  let llmInvalidOutput = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;

  for (const res of finalResults) {
    if (res.error === "llm_invalid_output") {
      llmInvalidOutput++;
    }
    if (res.status === "completed") {
      completed++;
      if (res.trufflehogResult === "verified") verified++;
      else if (res.trufflehogResult === "unverified") unverified++;
      else if (res.trufflehogResult === "unknown") unknown++;
      else if (res.trufflehogResult === "not_detected") notDetected++;
      else if (res.trufflehogResult === "ambiguous") ambiguous++;

      if (res.llmClassification === "false_positive" || res.llmClassification === "probable_false_positive") falsePositive++;
      else if (res.llmClassification === "likely_secret" || res.llmClassification === "probable_secret") likelySecret++;
      else if (res.llmClassification === "uncertain") uncertain++;
    } else if (res.status === "skipped") {
      skipped++;
    } else if (res.status === "failed") {
      failed++;
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
    unknown,
    notDetected,
    ambiguous,
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
