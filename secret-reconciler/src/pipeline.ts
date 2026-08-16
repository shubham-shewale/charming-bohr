import path from "node:path";
import pLimit from "p-limit";
import type { AppConfig } from "./config.js";
import { groupFindingsByContentIdentity, readFindingsCsv } from "./csv/reader.js";
import { writeResultsCsv } from "./csv/writer.js";
import { FileFetcher } from "./fetcher/file-fetcher.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "./trufflehog/matcher.js";
import { runTruffleHog, type RunTruffleHogOptions } from "./trufflehog/runner.js";
import type { CanonicalSource, FindingRef, FindingResult } from "./types.js";

export interface PipelineOptions {
  config: AppConfig;
  output?: string;
  retryFailed?: boolean;
  keepFiles?: boolean;
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
  trufflehogExecFn?: RunTruffleHogOptions["execFn"];
}

export interface PipelineSummary {
  outputPath: string;
  totalFindings: number;
  completed: number;
  verified: number;
  unverified: number;
  notFound: number;
  skipped: number;
  failed: number;
  results: FindingResult[];
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

  // Initialize file fetcher
  const fetcher = new FileFetcher({
    githubPat: config.githubPat,
    fetchProvider: options.fetchProvider,
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
        const detections = await runTruffleHog(localFilePath, {
          execFn: options.trufflehogExecFn,
        });
        return matchDetectionsToFindings(workItem.findings, detections);
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
      const nonPendingRes = matchDetectionsToFindings([finding], [])[0]!;
      finalResults.push(nonPendingRes);
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
  let skipped = 0;
  let failed = 0;

  for (const res of finalResults) {
    if (res.status === "completed") {
      completed++;
      if (res.trufflehogResult === "verified") verified++;
      else if (res.trufflehogResult === "unverified") unverified++;
      else if (res.trufflehogResult === "not_found") notFound++;
    } else if (res.status === "skipped") {
      skipped++;
    } else if (res.status === "failed") {
      failed++;
    }
  }

  return {
    outputPath,
    totalFindings: finalResults.length,
    completed,
    verified,
    unverified,
    notFound,
    skipped,
    failed,
    results: finalResults,
  };
}
