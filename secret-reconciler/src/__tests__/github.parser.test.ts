import { describe, it, expect } from "vitest";
import { parseGitHubScmLink } from "../parsers/github.js";
import type { CanonicalSource } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asserts the parse succeeded and returns the CanonicalSource for further
 * assertions. Fails the test immediately if the result is an error.
 */
function expectOk(rawUrl: string): CanonicalSource {
  const result = parseGitHubScmLink(rawUrl);
  if (!result.ok) {
    throw new Error(
      `Expected parse to succeed for URL:\n  ${rawUrl}\nBut got error: ${result.error.kind} — ${result.error.message}`
    );
  }
  return result.value;
}

/**
 * Asserts the parse failed with the given error kind. Returns the error for
 * further assertions.
 */
function expectErr(rawUrl: string, kind: string) {
  const result = parseGitHubScmLink(rawUrl);
  if (result.ok) {
    throw new Error(
      `Expected parse to fail for URL:\n  ${rawUrl}\nBut it succeeded with: ${JSON.stringify(result.value)}`
    );
  }
  expect(result.error.kind).toBe(kind);
  expect(result.error.rawUrl).toBe(rawUrl);
  return result.error;
}

// ---------------------------------------------------------------------------
// Valid URLs
// ---------------------------------------------------------------------------

describe("parseGitHubScmLink — valid URLs", () => {
  it("parses a canonical full GitHub blob URL with line range", () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/secrets.ts#L10-L20";

    const source = expectOk(url);

    expect(source).toEqual<CanonicalSource>({
      provider: "github",
      org: "acme",
      repo: "my-repo",
      revision: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      filePath: "src/secrets.ts",
      lineStart: 10,
      lineEnd: 20,
    });
  });

  it("parses a URL with a single line number (#L42) — lineEnd equals lineStart", () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/config/settings.py#L42";

    const source = expectOk(url);

    expect(source.lineStart).toBe(42);
    expect(source.lineEnd).toBe(42);
  });

  it("URL-decodes percent-encoded characters in the file path", () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/path/to/my%20file%2Bextra.ts#L1-L5";

    const source = expectOk(url);

    expect(source.filePath).toBe("path/to/my file+extra.ts");
  });

  it("handles deep nested file paths", () => {
    const url =
      "https://github.com/org/repo/blob/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/a/b/c/d/e/file.go#L100-L200";

    const source = expectOk(url);

    expect(source.filePath).toBe("a/b/c/d/e/file.go");
    expect(source.org).toBe("org");
    expect(source.repo).toBe("repo");
  });
});

// ---------------------------------------------------------------------------
// Malformed / unsupported URLs
// ---------------------------------------------------------------------------

describe("parseGitHubScmLink — error cases", () => {
  it('returns "unsupported-host" for a non-GitHub URL', () => {
    const url =
      "https://gitlab.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/main.ts#L1";
    expectErr(url, "unsupported-host");
  });

  it('returns "unsupported-host" for an Azure DevOps URL', () => {
    const url =
      "https://dev.azure.com/org/project/_git/repo?path=/src/main.ts&version=GCa1b2c3d4";
    expectErr(url, "unsupported-host");
  });

  it('returns "not-a-blob-url" when the path does not contain /blob/', () => {
    const url =
      "https://github.com/acme/my-repo/tree/main/src/main.ts#L1";
    expectErr(url, "not-a-blob-url");
  });

  it('returns "missing-revision" when the revision segment is a branch name (not a 40-char hex SHA)', () => {
    // "main" is a branch name — not a commit SHA
    const url =
      "https://github.com/acme/my-repo/blob/main/src/secrets.ts#L10-L20";
    expectErr(url, "missing-revision");
  });

  it('returns "missing-revision" when the revision is a short SHA (not 40 hex chars)', () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d/src/secrets.ts#L10-L20";
    expectErr(url, "missing-revision");
  });

  it('returns "missing-line-numbers" when the URL has no fragment', () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/main.ts";
    expectErr(url, "missing-line-numbers");
  });

  it('returns "missing-line-numbers" when the fragment does not match #L{n}', () => {
    const url =
      "https://github.com/acme/my-repo/blob/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2/src/main.ts#readme";
    expectErr(url, "missing-line-numbers");
  });
});
