#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, ConfigError } from "./config.js";
import { runPipeline, type PipelineProgress, type PipelineSummary } from "./pipeline.js";

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("secret-reconciler")
  .description(
    "Process secret-scanner findings CSVs, fetch the referenced source code, and classify each finding."
  )
  .version("0.1.0")
  .argument("<csv...>", "One or more CSV finding files to process")
  .option("-o, --output <path>", "Path to write the output CSV")
  .option("--retry-failed", "Re-process rows previously marked as failed", false)
  .option("--keep-files", "Do not delete fetched source files after processing")
  .option("--check-ids <ids...>", "Filter findings by one or more Check IDs")
  .option("-n, --limit <count>", "Limit reconciliation to the first N pending findings")
  .action(async (csvPaths: string[], options: {
    output?: string;
    retryFailed: boolean;
    keepFiles?: boolean;
    checkIds?: string[];
    limit?: string;
  }) => {
    // ── 1. Load and validate config — fail fast ─────────────────────────────
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`\n${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    // ── 2. Evaluate CLI overrides with precedence ────────────────────────────
    let cliCheckIds: string[] | undefined;
    if (options.checkIds && options.checkIds.length > 0) {
      const tokens = options.checkIds
        .flatMap((s) => s.split(","))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (tokens.length > 0) {
        cliCheckIds = tokens;
      }
    }

    let cliLimit: number | undefined;
    if (options.limit !== undefined) {
      const n = Number(options.limit);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(`\nInvalid --limit value "${options.limit}". Expected a positive integer (>= 1).\n\n`);
        process.exit(1);
      }
      cliLimit = n;
    }

    const effectiveCheckIds = cliCheckIds !== undefined ? cliCheckIds : config.checkIds;
    const effectiveLimit = cliLimit !== undefined ? cliLimit : config.limit;

    const effectiveConfig = {
      ...config,
      checkIds: effectiveCheckIds,
      limit: effectiveLimit,
    };

    // ── 3. Banner ────────────────────────────────────────────────────────────
    console.log("✓ Configuration loaded successfully.");
    console.log(`  Flow:        ${effectiveConfig.flow}`);
    console.log(`  Concurrency: ${effectiveConfig.concurrency}`);
    if (effectiveConfig.flow !== "trufflehog-only") {
      console.log(`  Model:       ${effectiveConfig.anthropicModel}`);
    }
    console.log(`  Check IDs:   ${effectiveConfig.checkIds && effectiveConfig.checkIds.length > 0 ? effectiveConfig.checkIds.join(", ") : "(all)"}`);
    console.log(`  Limit:       ${effectiveConfig.limit !== undefined ? effectiveConfig.limit : "(unlimited)"}`);
    console.log();

    // ── 4. Signal Handling (SIGINT/SIGTERM) ──────────────────────────────────
    const abortController = new AbortController();
    let sigintCount = 0;

    const handleSignal = (signalName: string) => {
      sigintCount++;
      if (sigintCount === 1) {
        process.stderr.write(`\nReceived ${signalName}. Stopping new work, finishing in-flight requests, and flushing output CSV...\n`);
        abortController.abort();
      } else {
        process.stderr.write(`\nForced termination on second ${signalName}.\n`);
        process.exit(130);
      }
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    // ── 5. Progress Reporting ────────────────────────────────────────────────
    let lastProgressLen = 0;
    const isInteractive = Boolean(process.stdout.isTTY);

    const clearProgressLine = () => {
      if (isInteractive && lastProgressLen > 0) {
        process.stdout.write("\n");
        lastProgressLen = 0;
      }
    };

    const onProgress = (progress: PipelineProgress) => {
      const line = `[Progress] Files: ${progress.filesProcessed}/${progress.totalFiles} | Findings: ${progress.findingsCompleted}/${progress.totalFindings} | Tokens: ${progress.tokensUsed} | Cost: $${progress.estimatedCostUsd.toFixed(4)}`;
      if (isInteractive) {
        process.stdout.write(`\r${line.padEnd(lastProgressLen, " ")}`);
        lastProgressLen = line.length;
      } else {
        console.log(line);
      }
    };

    const printSummaryMetrics = (pipelineSummary: PipelineSummary) => {
      console.log(`  Total:      ${pipelineSummary.totalFindings}`);
      if (effectiveConfig.checkIds && effectiveConfig.checkIds.length > 0) {
        console.log(`  Matched:    ${pipelineSummary.matchedCheckIds}`);
      }
      if (effectiveConfig.limit !== undefined || (effectiveConfig.checkIds && effectiveConfig.checkIds.length > 0)) {
        console.log(`  Selected:   ${pipelineSummary.selectedFindings}`);
      }
      console.log(`  Completed:  ${pipelineSummary.completed}`);
      if (pipelineSummary.pending > 0 || pipelineSummary.interrupted) {
        console.log(`  Pending:    ${pipelineSummary.pending}`);
      }
      if (!pipelineSummary.interrupted) {
        if (effectiveConfig.flow === "trufflehog-only") {
          console.log(`  TruffleHog: Completed: ${pipelineSummary.completed} (Verified: ${pipelineSummary.verified}, Unverified: ${pipelineSummary.unverified}, Unknown: ${pipelineSummary.unknown}, Not Detected: ${pipelineSummary.notDetected}, Ambiguous: ${pipelineSummary.ambiguous})`);
        } else if (effectiveConfig.flow === "hybrid") {
          const thScanned = pipelineSummary.verified + pipelineSummary.unverified + pipelineSummary.unknown + pipelineSummary.notDetected + pipelineSummary.ambiguous;
          console.log(`  TruffleHog: Scanned: ${thScanned} (Verified: ${pipelineSummary.verified}, Unverified: ${pipelineSummary.unverified}, Unknown: ${pipelineSummary.unknown}, Not Detected: ${pipelineSummary.notDetected}, Ambiguous: ${pipelineSummary.ambiguous})`);
        }

        if (effectiveConfig.flow === "hybrid" || effectiveConfig.flow === "llm-only") {
          console.log(`  LLM Classifications: False Positives: ${pipelineSummary.falsePositive}, Likely Secrets: ${pipelineSummary.likelySecret}, Uncertain: ${pipelineSummary.uncertain}, Invalid Output: ${pipelineSummary.llmInvalidOutput}`);
          if (pipelineSummary.tokenUsage) {
            console.log(`  Token Usage: Input: ${pipelineSummary.tokenUsage.inputTokens}, Output: ${pipelineSummary.tokenUsage.outputTokens}, Estimated Cost: $${pipelineSummary.tokenUsage.estimatedCostUsd.toFixed(6)}`);
          }
        }
      }
      console.log(`  Skipped:    ${pipelineSummary.skipped}`);
      console.log(`  Failed:     ${pipelineSummary.failed}`);
      if (pipelineSummary.tempDirKept) {
        console.log(`  Temp files kept at: ${pipelineSummary.tempDirKept}`);
      }
    };

    // ── 6. Run Pipeline ──────────────────────────────────────────────────────
    try {
      const summary = await runPipeline(csvPaths, {
        config: effectiveConfig,
        output: options.output,
        retryFailed: options.retryFailed,
        keepFiles: options.keepFiles,
        signal: abortController.signal,
        onProgress,
      });

      clearProgressLine();

      if (summary.interrupted) {
        console.log(`\n⚠ Run interrupted by signal. Completed findings saved to: ${summary.outputPath}`);
        printSummaryMetrics(summary);
        process.exit(130);
      }

      console.log(`✓ Reconciliation complete!`);
      console.log(`  Output CSV: ${summary.outputPath}`);
      printSummaryMetrics(summary);
    } catch (err: unknown) {
      clearProgressLine();
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Pipeline error: ${errMsg}`);
      process.exit(1);
    }
  });

program.parse();
