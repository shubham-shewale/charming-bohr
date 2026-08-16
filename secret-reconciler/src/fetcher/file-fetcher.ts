import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CanonicalSource } from "../types.js";
import { getContentIdentity } from "../csv/reader.js";
import { fetchGitHubFile } from "../providers/github-provider.js";

export interface FileFetcherOptions {
  githubPat: string;
  tempDir?: string;
  /** Optional custom provider override for testing or Azure DevOps extensibility. */
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
}

/**
 * FileFetcher manages downloading remote raw files, storing them in local `tmp/`,
 * and caching in-flight requests to deduplicate concurrent fetches for identical Content Identities.
 */
export class FileFetcher {
  private githubPat: string;
  private tempDir: string;
  private fetchProvider?: (source: CanonicalSource) => Promise<string>;
  private inFlightFetches = new Map<string, Promise<string>>();
  private savedFiles = new Map<string, string>();

  constructor(options: FileFetcherOptions) {
    this.githubPat = options.githubPat;
    this.tempDir = options.tempDir ?? path.join(process.cwd(), "tmp");
    this.fetchProvider = options.fetchProvider;
  }

  /**
   * Returns local file path for a CanonicalSource, fetching remote content if not already saved.
   * Deduplicates concurrent requests for the same Content Identity via an in-flight promise cache.
   */
  async fetchFile(source: CanonicalSource): Promise<string> {
    const key = getContentIdentity(source);

    // Return cached saved local path if available
    const existingPath = this.savedFiles.get(key);
    if (existingPath && fs.existsSync(existingPath)) {
      return existingPath;
    }

    // Return existing in-flight fetch promise if currently fetching
    const inFlight = this.inFlightFetches.get(key);
    if (inFlight) {
      return inFlight;
    }

    // Create a new fetch promise
    const promise = (async () => {
      try {
        const content = this.fetchProvider
          ? await this.fetchProvider(source)
          : await fetchGitHubFile(source, this.githubPat);

        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }

        const fileHash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
        const safeBasename = path.basename(source.filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
        const localPath = path.join(this.tempDir, `${fileHash}_${safeBasename}`);

        fs.writeFileSync(localPath, content, "utf-8");
        this.savedFiles.set(key, localPath);
        return localPath;
      } finally {
        this.inFlightFetches.delete(key);
      }
    })();

    this.inFlightFetches.set(key, promise);
    return promise;
  }

  /**
   * Deletes all saved temp files managed by this fetcher.
   */
  cleanup(): void {
    for (const filePath of this.savedFiles.values()) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
    this.savedFiles.clear();
  }
}
