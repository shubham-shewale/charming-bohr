import type { CanonicalSource, ScmParseResult } from "../types.js";
import { createParseError, SHA_RE } from "./errors.js";

// Matches #L{start} or #L{start}-L{end} fragments.
// Captures: group 1 = start line, group 2 = end line (optional).
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L(\d+))?$/;

/**
 * Parses a GitHub blob URL into a {@link CanonicalSource}.
 *
 * Expected format:
 *   https://github.com/{org}/{repo}/blob/{sha}/{path}#L{start}[-L{end}]
 *
 * Returns a {@link ScmParseResult} — never throws.
 */
export function parseGitHubScmLink(rawUrl: string): ScmParseResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return createParseError("unsupported-host", "URL is not valid.", rawUrl);
  }

  // ── 1. Host check ──────────────────────────────────────────────────────────
  if (parsed.hostname !== "github.com") {
    return createParseError(
      "unsupported-host",
      `Expected host "github.com" but got "${parsed.hostname}".`,
      rawUrl
    );
  }

  // ── 2. /blob/ path check ───────────────────────────────────────────────────
  // Pathname looks like: /{org}/{repo}/blob/{sha}/{filePath}
  // Split on "/" — first element is always "" because pathname starts with "/"
  const segments = parsed.pathname.split("/");
  // segments: ["", org, repo, "blob"|"tree"|..., sha, ...path]
  const blobIndex = segments.indexOf("blob");
  if (blobIndex === -1) {
    return createParseError(
      "not-a-blob-url",
      `URL path does not contain "/blob/". Found: "${parsed.pathname}".`,
      rawUrl
    );
  }

  const org = segments[1];
  const repo = segments[2];

  // A well-formed GitHub URL has exactly the shape:
  //   / {org} / {repo} / blob / {sha} / ...path
  // which means blobIndex must be 3. Any other position means the URL
  // is malformed (e.g. missing org, missing repo, extra prefix segments).
  if (blobIndex !== 3 || !org || !repo) {
    return createParseError(
      "not-a-blob-url",
      `Expected path shape "/{org}/{repo}/blob/..." but got "${parsed.pathname}".`,
      rawUrl
    );
  }

  // ── 3. Revision (commit SHA) check ────────────────────────────────────────
  const revision = segments[blobIndex + 1];
  if (!revision || !SHA_RE.test(revision)) {
    return createParseError(
      "missing-revision",
      `Expected a 40-character hex commit SHA after "/blob/" but got "${revision ?? "nothing"}". Branches are not accepted — use a full commit SHA.`,
      rawUrl
    );
  }

  // ── 4. File path ──────────────────────────────────────────────────────────
  // Everything after the SHA segment, re-joined and URL-decoded.
  const encodedPathSegments = segments.slice(blobIndex + 2);
  const filePath = encodedPathSegments
    .map((s) => decodeURIComponent(s))
    .join("/");

  if (!filePath) {
    return createParseError(
      "not-a-blob-url",
      `Expected a file path after commit SHA in "${parsed.pathname}".`,
      rawUrl
    );
  }

  // ── 5. Line number fragment ───────────────────────────────────────────────
  const fragment = parsed.hash.startsWith("#")
    ? parsed.hash.slice(1) // strip leading "#"
    : parsed.hash;

  if (!fragment) {
    return createParseError(
      "missing-line-numbers",
      `URL has no fragment. Expected "#L{start}" or "#L{start}-L{end}".`,
      rawUrl
    );
  }

  const lineMatch = LINE_FRAGMENT_RE.exec(fragment);
  if (!lineMatch) {
    return createParseError(
      "missing-line-numbers",
      `Fragment "#${fragment}" does not match "#L{start}" or "#L{start}-L{end}".`,
      rawUrl
    );
  }

  const lineStart = parseInt(lineMatch[1]!, 10);
  const lineEnd = lineMatch[2] !== undefined ? parseInt(lineMatch[2], 10) : lineStart;

  // ── 6. Success ────────────────────────────────────────────────────────────
  const source: CanonicalSource = {
    provider: "github",
    org,
    repo,
    revision,
    filePath,
    lineStart,
    lineEnd,
  };

  return { ok: true, value: source };
}
