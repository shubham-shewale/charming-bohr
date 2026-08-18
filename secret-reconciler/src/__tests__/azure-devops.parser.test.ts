import { describe, it, expect } from "vitest";
import { parseAzureDevOpsScmLink } from "../parsers/azure-devops.js";

describe("parseAzureDevOpsScmLink", () => {
  it("should parse a valid Azure DevOps SCM link", () => {
    const url = "https://dev.azure.com/my-org/my-project/_git/my-repo?path=/src/index.ts&version=GC0123456789abcdef0123456789abcdef01234567&_a=contents&line=10&lineEnd=15";
    const result = parseAzureDevOpsScmLink(url);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        provider: "azure",
        org: "my-org",
        project: "my-project",
        repo: "my-repo",
        revision: "0123456789abcdef0123456789abcdef01234567",
        filePath: "src/index.ts",
        lineStart: 10,
        lineEnd: 15,
      });
    }
  });

  it("should handle missing lineEnd by defaulting to lineStart", () => {
    const url = "https://dev.azure.com/org/proj/_git/repo?path=/file.txt&version=GC0123456789abcdef0123456789abcdef01234567&_a=contents&line=10";
    const result = parseAzureDevOpsScmLink(url);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lineStart).toBe(10);
      expect(result.value.lineEnd).toBe(10);
    }
  });

  it("should decode URL-encoded file paths correctly", () => {
    // path=/src/file%20with%20spaces.txt
    const url = "https://dev.azure.com/org/proj/_git/repo?path=%2Fsrc%2Ffile%20with%20spaces.txt&version=GC0123456789abcdef0123456789abcdef01234567&_a=contents&line=5";
    const result = parseAzureDevOpsScmLink(url);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filePath).toBe("src/file with spaces.txt");
    }
  });

  it("should fail for non dev.azure.com hosts", () => {
    const url = "https://github.com/org/proj/_git/repo?path=f&version=GC0123456789abcdef0123456789abcdef01234567&line=5";
    const result = parseAzureDevOpsScmLink(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported-host");
    }
  });

  it("should fail for invalid path shape", () => {
    const url = "https://dev.azure.com/org/proj/repo?path=f&version=GC0123456789abcdef0123456789abcdef01234567&line=5";
    const result = parseAzureDevOpsScmLink(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not-a-blob-url");
    }
  });

  it("should fail if version param is missing or doesn't start with GC", () => {
    const url = "https://dev.azure.com/org/proj/_git/repo?path=f&version=GBbranch&line=5";
    const result = parseAzureDevOpsScmLink(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-revision");
    }
  });

  it("should fail if line param is missing", () => {
    const url = "https://dev.azure.com/org/proj/_git/repo?path=f&version=GC0123456789abcdef0123456789abcdef01234567";
    const result = parseAzureDevOpsScmLink(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-line-numbers");
    }
  });
});
