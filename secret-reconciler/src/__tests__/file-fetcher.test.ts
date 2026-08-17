import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { FileFetcher } from "../fetcher/file-fetcher.js";
import { fetchGitHubFile, GitHubRateLimitError } from "../providers/github-provider.js";
import { TokenPool } from "../providers/token-pool.js";
import { getContentIdentity } from "../csv/reader.js";
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

  function makePool(token = "dummy-token") {
    return new TokenPool([token]);
  }

  // ── Basic fetch + save ─────────────────────────────────────────────────────

  it("fetches file using provider, saves to tempDir, and returns local file path", async () => {
    let callCount = 0;
    const fetcher = new FileFetcher({
      tokenPool: makePool(),
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
      tokenPool: makePool(),
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

  // ── Cross-run file cache ───────────────────────────────────────────────────

  it("returns cached file from disk without calling fetchProvider when it already exists", async () => {
    let callCount = 0;

    // Pre-create the expected file at the hash-based path (simulating a prior run)
    const contentIdentity = getContentIdentity(sampleSource);
    const fileHash = crypto
      .createHash("sha256")
      .update(contentIdentity)
      .digest("hex")
      .slice(0, 12);
    const safeBasename = path.basename(sampleSource.filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
    const cachedPath = path.join(testTmpDir, `${fileHash}_${safeBasename}`);
    fs.writeFileSync(cachedPath, "cached content from prior run", "utf-8");

    const fetcher = new FileFetcher({
      tokenPool: makePool(),
      tempDir: testTmpDir,
      fetchProvider: async () => {
        callCount++;
        return "fresh content that should not be fetched";
      },
    });

    const localPath = await fetcher.fetchFile(sampleSource);

    expect(localPath).toBe(cachedPath);
    expect(fs.readFileSync(localPath, "utf-8")).toBe("cached content from prior run");
    expect(callCount).toBe(0); // No network call!
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────

  it("cleans up saved files when cleanup() is called", async () => {
    const fetcher = new FileFetcher({
      tokenPool: makePool(),
      tempDir: testTmpDir,
      fetchProvider: async () => "content to cleanup",
    });

    const localPath = await fetcher.fetchFile(sampleSource);
    expect(fs.existsSync(localPath)).toBe(true);

    fetcher.cleanup();
    expect(fs.existsSync(localPath)).toBe(false);
  });

  // ── GitHub provider — return shape ─────────────────────────────────────────

  it("fetchGitHubFile calls GitHub API with correct authorization headers and returns rate-limit fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === "X-RateLimit-Remaining") return "4999";
          if (name === "X-RateLimit-Reset") return "1700000000";
          return null;
        },
      },
      text: async () => "github raw content",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchGitHubFile(sampleSource, "ghp_secretToken123");

    expect(result.content).toBe("github raw content");
    expect(result.rateLimitRemaining).toBe(4999);
    expect(result.rateLimitReset).toBe(1700000000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/my-org/my-repo/contents/src/secret.ts?ref=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
    expect(init.headers.Authorization).toBe("Bearer ghp_secretToken123");
    expect(init.headers.Accept).toBe("application/vnd.github.raw");
  });

  it("fetchGitHubFile throws GitHubRateLimitError on 403 with X-RateLimit-Reset header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: {
        get: (name: string) => {
          if (name === "X-RateLimit-Remaining") return "0";
          if (name === "X-RateLimit-Reset") return "1700001000";
          return null;
        },
      },
      text: async () => "rate limit exceeded",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchGitHubFile(sampleSource, "tok")).rejects.toThrow(GitHubRateLimitError);

    try {
      await fetchGitHubFile(sampleSource, "tok", 2);
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).resetAt).toBe(1700001000);
      expect((err as GitHubRateLimitError).tokenIndex).toBe(2);
    }
  });

  it("fetchGitHubFile throws GitHubRateLimitError on 429 with Retry-After header fallback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        get: (name: string) => {
          if (name === "X-RateLimit-Remaining") return "0";
          if (name === "X-RateLimit-Reset") return null;
          if (name === "Retry-After") return "60"; // 60-second retry
          return null;
        },
      },
      text: async () => "too many requests",
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await fetchGitHubFile(sampleSource, "tok");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      // resetAt should be approximately now + 60s
      const expectedReset = Math.floor(Date.now() / 1000) + 60;
      expect((err as GitHubRateLimitError).resetAt).toBeGreaterThanOrEqual(expectedReset - 2);
      expect((err as GitHubRateLimitError).resetAt).toBeLessThanOrEqual(expectedReset + 2);
    }
  });

  // ── GitHubRateLimitError propagation from FileFetcher ─────────────────────

  it("FileFetcher re-throws GitHubRateLimitError (does not swallow it)", async () => {
    const rateLimitErr = new GitHubRateLimitError(1700001000, 0);
    const fetcher = new FileFetcher({
      tokenPool: makePool(),
      tempDir: testTmpDir,
      fetchProvider: async () => {
        throw rateLimitErr;
      },
    });

    await expect(fetcher.fetchFile(sampleSource)).rejects.toThrow(GitHubRateLimitError);
  });

  // ── TokenPool reportUsage called after successful GitHub fetch ─────────────

  it("FileFetcher calls tokenPool.reportUsage with rate-limit fields after successful fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === "X-RateLimit-Remaining") return "1234";
          if (name === "X-RateLimit-Reset") return "1700002000";
          return null;
        },
      },
      text: async () => "file content",
    });
    vi.stubGlobal("fetch", mockFetch);

    const pool = new TokenPool(["ghp_realtoken"]);
    const reportSpy = vi.spyOn(pool, "reportUsage");

    const fetcher = new FileFetcher({
      tokenPool: pool,
      tempDir: testTmpDir,
      // No fetchProvider — uses real github route
    });

    await fetcher.fetchFile(sampleSource);

    expect(reportSpy).toHaveBeenCalledWith("ghp_realtoken", 1234, 1700002000);
  });

  it("FileFetcher calls tokenPool.reportUsage with 0 and resetAt when fetchGitHubFile hits rate limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: {
        get: (name: string) => {
          if (name === "X-RateLimit-Remaining") return "0";
          if (name === "X-RateLimit-Reset") return "1700003000";
          return null;
        },
      },
      text: async () => "rate limit exceeded",
    });
    vi.stubGlobal("fetch", mockFetch);

    const pool = new TokenPool(["ghp_limited_token"]);
    const reportSpy = vi.spyOn(pool, "reportUsage");

    const fetcher = new FileFetcher({
      tokenPool: pool,
      tempDir: testTmpDir,
    });

    await expect(fetcher.fetchFile(sampleSource)).rejects.toThrow(GitHubRateLimitError);

    expect(reportSpy).toHaveBeenCalledWith("ghp_limited_token", 0, 1700003000);
  });

  // ── Azure routing ──────────────────────────────────────────────────────────

  it("fetchAzureDevOpsFile calls Azure DevOps Items API with Basic auth and version params", async () => {
    const azureSource: CanonicalSource = {
      provider: "azure",
      org: "my-org",
      project: "my-project",
      repo: "my-repo",
      revision: "0123456789abcdef0123456789abcdef01234567",
      filePath: "src/azure.ts",
      lineStart: 1,
      lineEnd: 5,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "azure raw content",
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAzureDevOpsFile } = await import("../providers/azure-devops-provider.js");
    const content = await fetchAzureDevOpsFile(azureSource, "ado_pat_123");

    expect(content).toBe("azure raw content");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://dev.azure.com/my-org/my-project/_apis/git/repositories/my-repo/items?path=src%2Fazure.ts&versionDescriptor.version=0123456789abcdef0123456789abcdef01234567&versionDescriptor.versionType=commit&api-version=7.0");
    const expectedBasic = `Basic ${Buffer.from(":ado_pat_123").toString("base64")}`;
    expect(init.headers.Authorization).toBe(expectedBasic);
  });

  it("FileFetcher routes to fetchAzureDevOpsFile when provider is azure", async () => {
    const azureSource: CanonicalSource = {
      provider: "azure",
      org: "my-org",
      project: "my-project",
      repo: "my-repo",
      revision: "0123456789abcdef0123456789abcdef01234567",
      filePath: "src/azure.ts",
      lineStart: 1,
      lineEnd: 5,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "azure routed content",
    });
    vi.stubGlobal("fetch", mockFetch);

    const fetcher = new FileFetcher({
      tokenPool: makePool("dummy-gh"),
      azureDevOpsPat: "dummy-azure-pat",
      tempDir: testTmpDir,
    });

    const localPath = await fetcher.fetchFile(azureSource);
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.readFileSync(localPath, "utf-8")).toBe("azure routed content");
  });

  it("FileFetcher throws when AZURE_DEVOPS_PAT is missing for azure provider", async () => {
    const azureSource: CanonicalSource = {
      provider: "azure",
      org: "my-org",
      project: "my-project",
      repo: "my-repo",
      revision: "0123456789abcdef0123456789abcdef01234567",
      filePath: "src/azure.ts",
      lineStart: 1,
      lineEnd: 5,
    };

    const fetcher = new FileFetcher({
      tokenPool: makePool("dummy-gh"),
      tempDir: testTmpDir,
    });

    await expect(fetcher.fetchFile(azureSource)).rejects.toThrow("Missing AZURE_DEVOPS_PAT");
  });
});
