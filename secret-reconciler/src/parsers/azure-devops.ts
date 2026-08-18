import type { CanonicalSource, ScmParseResult } from "../types.js";
import { createParseError, SHA_RE } from "./errors.js";

/**
 * Parses an Azure DevOps file URL into a {@link CanonicalSource}.
 *
 * Expected format:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}?path={filePath}&version=GC{commitSHA}&_a=contents&line={start}&lineEnd={end}
 *
 * Returns a {@link ScmParseResult} — never throws.
 */
export function parseAzureDevOpsScmLink(rawUrl: string): ScmParseResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return createParseError("unsupported-host", "URL is not valid.", rawUrl);
  }

  // ── 1. Host check ──────────────────────────────────────────────────────────
  if (parsed.hostname !== "dev.azure.com") {
    return createParseError(
      "unsupported-host",
      `Expected host "dev.azure.com" but got "${parsed.hostname}".`,
      rawUrl
    );
  }

  // ── 2. Path shape check ────────────────────────────────────────────────────
  // Pathname looks like: /{org}/{project}/_git/{repo}
  const segments = parsed.pathname.split("/");
  // segments: ["", org, project, "_git", repo, ...]
  if (segments.length < 5 || segments[3] !== "_git") {
    return createParseError(
      "not-a-blob-url",
      `Expected path shape "/{org}/{project}/_git/{repo}" but got "${parsed.pathname}".`,
      rawUrl
    );
  }

  const org = segments[1];
  const project = segments[2];
  const repo = segments[4];

  if (!org || !project || !repo) {
    return createParseError(
      "not-a-blob-url",
      `Missing org, project, or repo in path "${parsed.pathname}".`,
      rawUrl
    );
  }

  // ── 3. File path ───────────────────────────────────────────────────────────
  const filePathRaw = parsed.searchParams.get("path");
  if (!filePathRaw) {
    return createParseError(
      "not-a-blob-url",
      `Missing "path" query parameter.`,
      rawUrl
    );
  }
  // URLSearchParams automatically decodes the value, but let's be sure.
  const filePath = filePathRaw.startsWith("/") ? filePathRaw.slice(1) : filePathRaw;

  // ── 4. Revision (commit SHA) check ─────────────────────────────────────────
  const version = parsed.searchParams.get("version");
  if (!version || !version.startsWith("GC")) {
    return createParseError(
      "missing-revision",
      `Expected a "version" query parameter starting with "GC" (Commit), but got "${version ?? "nothing"}".`,
      rawUrl
    );
  }

  const revision = version.slice(2);
  if (!SHA_RE.test(revision)) {
    return createParseError(
      "missing-revision",
      `Expected a 40-character hex commit SHA after "GC" but got "${revision}".`,
      rawUrl
    );
  }

  // ── 5. Line numbers ────────────────────────────────────────────────────────
  const lineStartStr = parsed.searchParams.get("line");
  if (!lineStartStr) {
    return createParseError(
      "missing-line-numbers",
      `Missing "line" query parameter.`,
      rawUrl
    );
  }

  const lineStart = parseInt(lineStartStr, 10);
  if (isNaN(lineStart)) {
    return createParseError(
      "missing-line-numbers",
      `Invalid "line" query parameter: "${lineStartStr}".`,
      rawUrl
    );
  }

  const lineEndStr = parsed.searchParams.get("lineEnd");
  let lineEnd = lineStart;
  if (lineEndStr) {
    lineEnd = parseInt(lineEndStr, 10);
    if (isNaN(lineEnd)) {
      return createParseError(
        "missing-line-numbers",
        `Invalid "lineEnd" query parameter: "${lineEndStr}".`,
        rawUrl
      );
    }
  }

  // ── 6. Success ────────────────────────────────────────────────────────────
  const source: CanonicalSource = {
    provider: "azure",
    org,
    project,
    repo,
    revision,
    filePath,
    lineStart,
    lineEnd,
  };

  return { ok: true, value: source };
}
