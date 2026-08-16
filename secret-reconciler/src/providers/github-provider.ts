import type { CanonicalSource } from "../types.js";

/**
 * Fetches raw file content from GitHub REST API for a specific CanonicalSource.
 *
 * Uses:
 * GET https://api.github.com/repos/{org}/{repo}/contents/{filePath}?ref={revision}
 * Header: Accept: application/vnd.github.raw
 */
export async function fetchGitHubFile(
  source: CanonicalSource,
  token: string
): Promise<string> {
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

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `GitHub API error (${response.status}): ${response.statusText}${errText ? ` - ${errText}` : ""}`
    );
  }

  return await response.text();
}
