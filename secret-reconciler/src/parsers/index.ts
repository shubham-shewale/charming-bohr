import type { ScmParseResult } from "../types.js";
import { parseGitHubScmLink } from "./github.js";
import { parseAzureDevOpsScmLink } from "./azure-devops.js";
import { createParseError } from "./errors.js";

/**
 * Determines the SCM provider from the SCM link and calls the appropriate parser.
 * Supported providers: GitHub, Azure DevOps.
 */
export function parseScmLink(rawUrl: string): ScmParseResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return createParseError("unsupported-host", "SCM link is not valid.", rawUrl);
  }

  if (parsed.hostname === "github.com") {
    return parseGitHubScmLink(rawUrl);
  } else if (parsed.hostname === "dev.azure.com") {
    return parseAzureDevOpsScmLink(rawUrl);
  }

  return createParseError(
    "unsupported-host",
    `Unsupported host "${parsed.hostname}". Only github.com and dev.azure.com are supported.`,
    rawUrl
  );
}
