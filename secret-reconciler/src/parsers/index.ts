import type { ScmParseResult } from "../types.js";
import { parseGitHubScmLink } from "./github.js";
import { parseAzureDevOpsScmLink } from "./azure-devops.js";

/**
 * Determines the SCM provider from the URL and calls the appropriate parser.
 * Supported providers: GitHub, Azure DevOps.
 */
export function parseScmLink(rawUrl: string): ScmParseResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: { kind: "unsupported-host", message: "URL is not valid.", rawUrl } };
  }

  if (parsed.hostname === "github.com") {
    return parseGitHubScmLink(rawUrl);
  } else if (parsed.hostname === "dev.azure.com") {
    return parseAzureDevOpsScmLink(rawUrl);
  }

  return {
    ok: false,
    error: {
      kind: "unsupported-host",
      message: `Unsupported host "${parsed.hostname}". Only github.com and dev.azure.com are supported.`,
      rawUrl,
    },
  };
}
