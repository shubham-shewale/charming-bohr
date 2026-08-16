import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileFetcher } from "../fetcher/file-fetcher.js";
import { fetchGitHubFile } from "../providers/github-provider.js";
import type { CanonicalSource } from "../types.js";

describe("FileFetcher & GitHub Provider", () => {
  let testTmpDir: string;

  beforeEach(() => {
    testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-fetcher-test-"));
  });

  afterEach(() => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const sampleSource: CanonicalSource = {
    provider: "github",
    org: "my-org",
    repo: "my-repo",
    revision: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    filePath: "src/secret.ts",
    lineStart: 5,
    lineEnd: 10,
  };

  it("fetches file using provider, saves to tempDir, and returns local file path", async () => {
    let callCount = 0;
    const fetcher = new FileFetcher({
      githubPat: "dummy-token",
      tempDir: testTmpDir,
      fetchProvider: async () => {
        callCount++;
        return "const API_KEY = 'secret123';";
      },
    });

    const localPath = await fetcher.fetchFile(sampleSource);
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.readFileSync(localPath, "utf-8")).toBe("const API_KEY = 'secret123';");
    expect(callCount).toBe(1);
  });

  it("deduplicates in-flight concurrent requests for the same Content Identity", async () => {
    let callCount = 0;
    const fetcher = new FileFetcher({
      githubPat: "dummy-token",
      tempDir: testTmpDir,
      fetchProvider: async () => {
        callCount++;
        // Small delay to simulate async network latency
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "content";
      },
    });

    // Launch 3 concurrent fetch operations for identical content identity
    const results = await Promise.all([
      fetcher.fetchFile(sampleSource),
      fetcher.fetchFile(sampleSource),
      fetcher.fetchFile(sampleSource),
    ]);

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(callCount).toBe(1); // Provider called only once!
  });

  it("cleans up saved files when cleanup() is called", async () => {
    const fetcher = new FileFetcher({
      githubPat: "dummy-token",
      tempDir: testTmpDir,
      fetchProvider: async () => "content to cleanup",
    });

    const localPath = await fetcher.fetchFile(sampleSource);
    expect(fs.existsSync(localPath)).toBe(true);

    fetcher.cleanup();
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it("fetchGitHubFile calls GitHub API with correct authorization headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "github raw content",
    });
    vi.stubGlobal("fetch", mockFetch);

    const content = await fetchGitHubFile(sampleSource, "ghp_secretToken123");

    expect(content).toBe("github raw content");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/my-org/my-repo/contents/src/secret.ts?ref=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
    expect(init.headers.Authorization).toBe("Bearer ghp_secretToken123");
    expect(init.headers.Accept).toBe("application/vnd.github.raw");
  });
});

