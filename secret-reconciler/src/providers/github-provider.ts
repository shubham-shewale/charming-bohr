import type { CanonicalSource } from "../types.js";

/**
 * Thrown when GitHub returns 403 or 429 indicating the rate-limit has been exhausted.
 * Carries the reset timestamp so callers can compute the sleep duration.
 */
export class GitHubRateLimitError extends Error {
  /** UTC epoch seconds when the rate-limit window resets. */
  readonly resetAt: number;
  /** Index of the token slot that was exhausted (for diagnostics). */
  readonly tokenIndex: number;

  constructor(resetAt: number, tokenIndex: number = 0) {
    super(`GitHub rate limit exceeded. Resets at ${new Date(resetAt * 1000).toISOString()}.`);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
    this.tokenIndex = tokenIndex;
  }
}

/**
 * Result shape returned by fetchGitHubFile.
 * Includes the file content and rate-limit header values so the caller
 * can update the TokenPool state.
 */
export interface GitHubFetchResult {
  content: string;
  rateLimitRemaining: number;
  rateLimitReset: number;
}

/**
 * Fetches raw file content from GitHub REST API for a specific CanonicalSource.
 *
 * Uses:
 * GET https://api.github.com/repos/{org}/{repo}/contents/{filePath}?ref={revision}
 * Header: Accept: application/vnd.github.raw
 *
 * Parses X-RateLimit-Remaining and X-RateLimit-Reset from every response.
 * Throws GitHubRateLimitError on 403 / 429.
 */
export async function fetchGitHubFile(
  source: CanonicalSource,
  token: string,
  tokenIndex: number = 0
): Promise<GitHubFetchResult> {
  const encodedPath = source.filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const url = `https://api.github.com/repos/${encodeURIComponent(source.org)}/${encodeURIComponent(source.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(source.revision)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "secret-reconciler",
    },
  });

  // Parse rate-limit headers from every response (success or error)
  const rateLimitRemaining = parseInt(response.headers.get("X-RateLimit-Remaining") ?? "Infinity", 10);
  const rateLimitReset = parseInt(response.headers.get("X-RateLimit-Reset") ?? "0", 10);

  if (response.status === 403 || response.status === 429) {
    // Compute resetAt: prefer X-RateLimit-Reset, fall back to Retry-After
    let resetAt = rateLimitReset;
    if (!resetAt) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "0", 10);
      resetAt = Math.floor(Date.now() / 1000) + (retryAfter || 3600);
    }
    throw new GitHubRateLimitError(resetAt, tokenIndex);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `GitHub API error (${response.status}): ${response.statusText}${errText ? ` - ${errText}` : ""}`
    );
  }

  const content = await response.text();
  return { content, rateLimitRemaining, rateLimitReset };
}
