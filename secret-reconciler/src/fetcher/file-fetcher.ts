import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CanonicalSource } from "../types.js";
import { getContentIdentity } from "../csv/reader.js";
import { fetchGitHubFile } from "../providers/github-provider.js";
import { fetchAzureDevOpsFile } from "../providers/azure-devops-provider.js";

export interface FileFetcherOptions {
  githubPat: string;
  azureDevOpsPat?: string;
  tempDir?: string;
  /** Optional custom provider override for testing. */
  fetchProvider?: (source: CanonicalSource) => Promise<string>;
}

/**
 * FileFetcher manages downloading remote raw files, storing them in local `tmp/`,
 * and caching in-flight requests to deduplicate concurrent fetches for identical Content Identities.
 */
export class FileFetcher {
  private githubPat: string;
  private azureDevOpsPat?: string;
  private tempDir: string;
  private fetchProvider?: (source: CanonicalSource) => Promise<string>;
  private inFlightFetches = new Map<string, Promise<string>>();
  private savedFiles = new Map<string, string>();

  constructor(options: FileFetcherOptions) {
    this.githubPat = options.githubPat;
    this.azureDevOpsPat = options.azureDevOpsPat;
    this.tempDir =
      options.tempDir ??
      path.join(process.cwd(), "tmp", `run-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    this.fetchProvider = options.fetchProvider;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Returns local file path for a CanonicalSource, fetching remote content if not already saved.
   * Deduplicates concurrent requests for the same Content Identity via an in-flight promise cache.
   */
  async fetchFile(source: CanonicalSource): Promise<string> {
    const contentIdentity = getContentIdentity(source);

    // Return cached saved local path if available
    const existingPath = this.savedFiles.get(contentIdentity);
    if (existingPath && fs.existsSync(existingPath)) {
      return existingPath;
    }

    // Return existing in-flight fetch promise if currently fetching
    const inFlight = this.inFlightFetches.get(contentIdentity);
    if (inFlight) {
      return inFlight;
    }

    // Create a new fetch promise
    const promise = (async () => {
      try {
        let content = "";
        if (this.fetchProvider) {
          content = await this.fetchProvider(source);
        } else if (source.provider === "github") {
          content = await fetchGitHubFile(source, this.githubPat);
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

        const fileHash = crypto.createHash("sha256").update(contentIdentity).digest("hex").slice(0, 12);
        const safeBasename = path.basename(source.filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
        const localPath = path.join(this.tempDir, `${fileHash}_${safeBasename}`);

        fs.writeFileSync(localPath, content, "utf-8");
        this.savedFiles.set(contentIdentity, localPath);
        return localPath;
      } finally {
        this.inFlightFetches.delete(contentIdentity);
      }
    })();

    this.inFlightFetches.set(contentIdentity, promise);
    return promise;
  }

  /**
   * Deletes the temp directory and all fetched files managed by this fetcher.
   */
  cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    this.savedFiles.clear();
  }
}
