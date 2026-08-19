export interface LlmFileEligibility {
  eligible: boolean;
  reason?: string;
  matchedPattern?: string;
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index++;
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  return source;
}

/**
 * Matches a configured LLM ignore pattern against an SCM repository-relative path.
 *
 * - A basename pattern such as `*.log` matches in every directory.
 * - A directory pattern such as `node_modules/` matches that complete path segment.
 * - A path pattern such as `generated/**` matches at any repository depth.
 */
export function matchesLlmIgnorePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern.trim());
  if (!normalizedPattern) return false;

  if (pattern.trim().replace(/\\/g, "/").endsWith("/")) {
    const directoryPattern = normalizedPattern.replace(/\/+$/, "");
    return new RegExp(`(?:^|/)${globSource(directoryPattern)}(?:/|$)`, "i")
      .test(normalizedPath);
  }

  if (!normalizedPattern.includes("/")) {
    const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
    return new RegExp(`^${globSource(normalizedPattern)}$`, "i").test(basename);
  }

  return new RegExp(`(?:^|/)${globSource(normalizedPattern)}$`, "i")
    .test(normalizedPath);
}

export function evaluateLlmFileEligibility(
  filePath: string,
  sizeBytes: number | undefined,
  maxFileSizeKb: number,
  ignorePatterns: string[] = []
): LlmFileEligibility {
  const matchedPattern = ignorePatterns.find((pattern) =>
    matchesLlmIgnorePattern(filePath, pattern)
  );
  if (matchedPattern) {
    return {
      eligible: false,
      matchedPattern,
      reason: `File path matches LLM_IGNORE_PATTERNS pattern "${matchedPattern}"`,
    };
  }

  if (sizeBytes !== undefined && sizeBytes > maxFileSizeKb * 1024) {
    const sizeKb = (sizeBytes / 1024).toFixed(1);
    return {
      eligible: false,
      reason: `File size (${sizeKb} KB) exceeds MAX_FILE_SIZE_KB limit of ${maxFileSizeKb} KB`,
    };
  }

  return { eligible: true };
}
