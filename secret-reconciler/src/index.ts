#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, ConfigError } from "./config.js";


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
  .option("-o, --output <path>", "Path to write the output CSV (default: <first-input>-out.csv)")
  .option("--retry-failed", "Re-process rows previously marked as failed", false)
  .option("--keep-files", "Do not delete fetched source files after processing", false)
  .action(async (csvPaths: string[], options: { output?: string; retryFailed: boolean; keepFiles: boolean }) => {
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
    console.log(`Input file(s):`);
    for (const p of csvPaths) {
      console.log(`  • ${p}`);
    }
    if (options.output) console.log(`Output:  ${options.output}`);
    if (options.retryFailed) console.log("  --retry-failed: ON");
    if (options.keepFiles) console.log("  --keep-files:   ON");
    console.log();
    console.log("Pipeline not yet implemented (ticket 02+).");
  });

program.parse();
