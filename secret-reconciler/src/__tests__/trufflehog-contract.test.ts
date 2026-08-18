import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSupportedTruffleHogVersion,
  runTruffleHog,
  SUPPORTED_TRUFFLEHOG_VERSION,
} from "../trufflehog/runner.js";

const contractEnabled = process.env["TRUFFLEHOG_CONTRACT_TEST"] === "1";
const describeContract = contractEnabled ? describe : describe.skip;

describeContract("TruffleHog real CLI contract", () => {
  let tempDir: string;
  let cleanFile: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-trufflehog-"));
    cleanFile = path.join(tempDir, "clean.txt");
    fs.writeFileSync(cleanFile, "This fixture intentionally contains no credentials.\n", "utf8");
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it(`runs against TruffleHog ${SUPPORTED_TRUFFLEHOG_VERSION}`, async () => {
    await expect(assertSupportedTruffleHogVersion()).resolves.toBeUndefined();
  });

  it("accepts the filesystem command and parses a clean scan", async () => {
    await expect(runTruffleHog(cleanFile, { verificationMode: "no-verification" })).resolves.toEqual([]);
  });
});
