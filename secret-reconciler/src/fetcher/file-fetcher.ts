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
  fetchProvider?: (source: CanonicalSource, signal?: AbortSignal) => Promise<string>;
  /** Hard-cancellation signal used after the graceful shutdown window. */
  signal?: AbortSignal;
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
 * FileFetcher manages downloading remote raw files, storing them in a local temp directory,
 * and caching in-flight requests to deduplicate concurrent fetches for identical
 * Content Identities.
 *
 * When callers explicitly provide a shared temp directory, an existing
 * content-identity-hashed file is reused without another network call.
 */
export class FileFetcher {
  private tokenPool: TokenPool;
  private azureDevOpsPat?: string;
  private tempDir: string;
  private fetchProvider?: (source: CanonicalSource, signal?: AbortSignal) => Promise<string>;
  private signal?: AbortSignal;
  private ownsTempDir: boolean;
  private ownedFiles = new Set<string>();
  private inFlightFetches = new Map<string, Promise<string>>();

  constructor(options: FileFetcherOptions) {
    this.tokenPool = options.tokenPool;
    this.azureDevOpsPat = options.azureDevOpsPat;
    this.ownsTempDir = options.tempDir === undefined;
    if (options.tempDir) {
      this.tempDir = options.tempDir;
    } else {
      const baseTempDir = path.join(process.cwd(), "tmp");
      fs.mkdirSync(baseTempDir, { recursive: true });
      this.tempDir = fs.mkdtempSync(path.join(baseTempDir, "run-"));
    }
    this.fetchProvider = options.fetchProvider;
    this.signal = options.signal;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Computes the deterministic local path for a given content identity.
   * Used for both explicit shared-cache checks and writing new files.
   */
  private localPath(source: CanonicalSource): string {
    return getLocalCachePath(this.tempDir, source);
  }

  private throwIfAborted(): void {
    if (!this.signal?.aborted) return;
    const error = new Error("File fetch aborted");
    error.name = "AbortError";
    throw error;
  }

  /** Publishes a fully-written immutable cache file without exposing partial content. */
  private writeAtomically(localPath: string, content: string): void {
    fs.mkdirSync(this.tempDir, { recursive: true });
    const temporaryPath = `${localPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    fs.writeFileSync(temporaryPath, content, "utf-8");

    try {
      fs.linkSync(temporaryPath, localPath);
      this.ownedFiles.add(localPath);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  /**
   * Returns local file path for a CanonicalSource, fetching remote content if not already saved.
   * Deduplicates concurrent requests for the same Content Identity via an in-flight promise cache.
   * Checks an explicitly shared on-disk cache before issuing any network call.
   *
   * Re-throws GitHubRateLimitError so the pipeline can defer the work item.
   */
  async fetchFile(source: CanonicalSource): Promise<string> {
    this.throwIfAborted();
    const contentIdentity = getContentIdentity(source);

    // ── Shared disk cache: return immediately if file already exists ────────
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
              content = await this.fetchProvider(source, this.signal);
            } else {
              const result = await fetchGitHubFile(source, token, 0, this.signal);
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
          content = await this.fetchProvider(source, this.signal);
        } else if (source.provider === "azure") {
          if (!this.azureDevOpsPat) {
            throw new Error("Missing AZURE_DEVOPS_PAT for Azure DevOps source");
          }
          content = await fetchAzureDevOpsFile(source, this.azureDevOpsPat, this.signal);
        } else {
          throw new Error(`Unsupported provider: ${source.provider}`);
        }

        this.throwIfAborted();
        const localPath = this.localPath(source);
        this.writeAtomically(localPath, content);
        return localPath;
      } finally {
        this.inFlightFetches.delete(contentIdentity);
      }
    })();

    this.inFlightFetches.set(contentIdentity, promise);
    return promise;
  }

  /**
   * Deletes only files created by this fetcher. Cached/pre-existing files in
   * an explicitly shared temp directory belong to their creating run.
   */
  cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      try {
        for (const file of this.ownedFiles) {
          fs.rmSync(file, { force: true });
        }
        this.ownedFiles.clear();
        const remaining = fs.readdirSync(this.tempDir);
        if (remaining.length === 0 && this.ownsTempDir) {
          fs.rmdirSync(this.tempDir);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
