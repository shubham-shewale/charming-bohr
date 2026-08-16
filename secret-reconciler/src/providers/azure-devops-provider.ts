import type { CanonicalSource } from "../types.js";

/**
 * Fetches raw file content from Azure DevOps Items REST API for a specific CanonicalSource.
 *
 * Uses:
 * GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/items?path={path}&versionDescriptor.version={sha}&versionDescriptor.versionType=commit&api-version=7.0
 * Auth: Basic {base64(":" + token)}
 */
export async function fetchAzureDevOpsFile(
  source: CanonicalSource,
  token: string
): Promise<string> {
  if (!source.project) {
    throw new Error("Missing project in Azure DevOps CanonicalSource");
  }

  const encodedPath = encodeURIComponent(source.filePath);
  const url = `https://dev.azure.com/${encodeURIComponent(source.org)}/${encodeURIComponent(source.project)}/_apis/git/repositories/${encodeURIComponent(source.repo)}/items?path=${encodedPath}&versionDescriptor.version=${encodeURIComponent(source.revision)}&versionDescriptor.versionType=commit&api-version=7.0`;

  const authHeader = `Basic ${Buffer.from(`:${token}`).toString("base64")}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "text/plain",
      "User-Agent": "secret-reconciler",
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Azure DevOps API error (${response.status}): ${response.statusText}${errText ? ` - ${errText}` : ""}`
    );
  }

  return await response.text();
}
