import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CanonicalSource } from "../types.js";
import { getContentIdentity } from "../csv/reader.js";
import { fetchGitHubFile, GitHubRateLimitError } from "../providers/github-provider.js";
import { fetchAzureDevOpsFile } from "../providers/azure-devops-provider.js";
import type { TokenPool } from "../providers/token-pool.js";

export interface FileFetcherOptions {
  tokenPool: TokenPool;
  azureDevOpsPat?: string;
  tempDir?: string;
  /** Optional custom provider override for testing. */
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
}

/**
 * Computes the deterministic local path for a given CanonicalSource in the target temp directory.
 * Content identity includes provider, repository, revision, and file path.
 */
export function getLocalCachePath(tempDir: string, source: CanonicalSource): string {
  const contentIdentity = getContentIdentity(source);
  const fileHash = crypto
    .createHash("sha256")
    .update(contentIdentity)
    .digest("hex")
    .slice(0, 12);
  const safeBasename = path.basename(source.filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(tempDir, `${fileHash}_${safeBasename}`);
}

/**
 * FileFetcher manages downloading remote raw files, storing them in a shared local `tmp/`
 * directory, and caching in-flight requests to deduplicate concurrent fetches for identical
 * Content Identities.
 *
 * Cross-run file cache: before any remote fetch, checks whether the content-identity-hashed
 * file already exists on disk from a prior run. If so, returns it immediately without a
 * network call.
 */
export class FileFetcher {
  private tokenPool: TokenPool;
  private azureDevOpsPat?: string;
  private tempDir: string;
  private fetchProvider?: (source: CanonicalSource) => Promise<string>;
  private inFlightFetches = new Map<string, Promise<string>>();

  constructor(options: FileFetcherOptions) {
    this.tokenPool = options.tokenPool;
    this.azureDevOpsPat = options.azureDevOpsPat;
    this.tempDir = options.tempDir ?? path.join(process.cwd(), "tmp");
    this.fetchProvider = options.fetchProvider;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Computes the deterministic local path for a given content identity.
   * Used for both cross-run cache checks and writing new files.
   */
  private localPath(source: CanonicalSource): string {
    return getLocalCachePath(this.tempDir, source);
  }

  /**
   * Returns local file path for a CanonicalSource, fetching remote content if not already saved.
   * Deduplicates concurrent requests for the same Content Identity via an in-flight promise cache.
   * Checks the cross-run on-disk cache before issuing any network call.
   *
   * Re-throws GitHubRateLimitError so the pipeline can defer the work item.
   */
  async fetchFile(source: CanonicalSource): Promise<string> {
    const contentIdentity = getContentIdentity(source);

    // ── Cross-run disk cache: return immediately if file already exists ──────
    const deterministic = this.localPath(source);
    if (fs.existsSync(deterministic)) {
      return deterministic;
    }

    // ── In-flight deduplication ──────────────────────────────────────────────
    const inFlight = this.inFlightFetches.get(contentIdentity);
    if (inFlight) {
      return inFlight;
    }

    // ── Create a new fetch promise ───────────────────────────────────────────
    const promise = (async () => {
      try {
        let content = "";
        if (source.provider === "github") {
          const token = this.tokenPool.getToken();
          try {
            if (this.fetchProvider) {
              content = await this.fetchProvider(source);
            } else {
              const result = await fetchGitHubFile(source, token);
              this.tokenPool.reportUsage(token, result.rateLimitRemaining, result.rateLimitReset);
              content = result.content;
            }
          } catch (err) {
            if (err instanceof GitHubRateLimitError) {
              this.tokenPool.reportUsage(token, 0, err.resetAt);
            }
            throw err;
          }
        } else if (this.fetchProvider) {
          content = await this.fetchProvider(source);
        } else if (source.provider === "azure") {
          if (!this.azureDevOpsPat) {
            throw new Error("Missing AZURE_DEVOPS_PAT for Azure DevOps source");
          }
          content = await fetchAzureDevOpsFile(source, this.azureDevOpsPat);
        } else {
          throw new Error(`Unsupported provider: ${source.provider}`);
        }

        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }

        const localPath = this.localPath(source);
        fs.writeFileSync(localPath, content, "utf-8");
        return localPath;
      } finally {
        this.inFlightFetches.delete(contentIdentity);
      }
    })();

    this.inFlightFetches.set(contentIdentity, promise);
    return promise;
  }

  /**
   * Deletes all files in the temp directory managed by this fetcher.
   * Removes the directory itself only when it is empty after deletion.
   */
  cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      try {
        // Delete each file individually so we can handle a shared tempDir
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.rmSync(path.join(this.tempDir, file), { force: true });
        }
        // Remove the directory only if now empty
        const remaining = fs.readdirSync(this.tempDir);
        if (remaining.length === 0) {
          fs.rmdirSync(this.tempDir);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
