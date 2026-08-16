#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, ConfigError } from "./config.js";
import { runPipeline, type PipelineProgress } from "./pipeline.js";

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
  .action(async (csvPaths: string[], options: { output?: string; retryFailed: boolean; keepFiles?: boolean }) => {
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

    // ── 2. Banner ────────────────────────────────────────────────────────────
    console.log("✓ Configuration loaded successfully.");
    console.log(`  Flow:        ${config.flow}`);
    console.log(`  Concurrency: ${config.concurrency}`);
    console.log(`  Model:       ${config.anthropicModel}`);
    console.log();

    // ── 3. Signal Handling (SIGINT/SIGTERM) ──────────────────────────────────
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

    // ── 4. Progress Reporting ────────────────────────────────────────────────
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

    // ── 5. Run Pipeline ──────────────────────────────────────────────────────
    try {
      const summary = await runPipeline(csvPaths, {
        config,
        output: options.output,
        retryFailed: options.retryFailed,
        keepFiles: options.keepFiles,
        signal: abortController.signal,
        onProgress,
      });

      clearProgressLine();

      if (summary.interrupted) {
        console.log(`\n⚠ Run interrupted by signal. Completed findings saved to: ${summary.outputPath}`);
        console.log(`  Total:      ${summary.totalFindings}`);
        console.log(`  Completed:  ${summary.completed}`);
        console.log(`  Pending:    ${summary.pending}`);
        console.log(`  Skipped:    ${summary.skipped}`);
        console.log(`  Failed:     ${summary.failed}`);
        if (summary.tempDirKept) {
          console.log(`  Temp files kept at: ${summary.tempDirKept}`);
        }
        process.exit(130);
      }

      console.log(`✓ Reconciliation complete!`);
      console.log(`  Output CSV: ${summary.outputPath}`);
      console.log(`  Total:      ${summary.totalFindings}`);
      if (config.flow !== "llm-only") {
        console.log(`  TruffleHog: Completed: ${summary.completed} (Verified: ${summary.verified}, Unverified: ${summary.unverified}, Not Found: ${summary.notFound})`);
      }
      if (config.flow !== "trufflehog-only") {
        console.log(`  LLM Classifications: False Positives: ${summary.falsePositive}, Likely Secrets: ${summary.likelySecret}, Uncertain: ${summary.uncertain}, Invalid Output: ${summary.llmInvalidOutput}`);
        if (summary.tokenUsage) {
          console.log(`  Token Usage: Input: ${summary.tokenUsage.inputTokens}, Output: ${summary.tokenUsage.outputTokens}, Estimated Cost: $${summary.tokenUsage.estimatedCostUsd.toFixed(6)}`);
        }
      }
      console.log(`  Skipped:    ${summary.skipped}`);
      console.log(`  Failed:     ${summary.failed}`);
      if (summary.tempDirKept) {
        console.log(`  Temp files kept at: ${summary.tempDirKept}`);
      }
    } catch (err: unknown) {
      clearProgressLine();
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Pipeline error: ${errMsg}`);
      process.exit(1);
    }
  });

program.parse();
