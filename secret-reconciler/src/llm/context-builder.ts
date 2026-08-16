/**
 * Options for context building.
 */
export interface ContextBuilderOptions {
  surroundingLines: number;
  maxBytes?: number;
  maxLines?: number;
}

export interface FindingLineRange {
  lineStart: number;
  lineEnd: number;
  title?: string;
}

export interface MergedRange {
  start: number;
  end: number;
}

export interface CodeContextResult {
  formattedContext: string;
  mergedRanges: MergedRange[];
  truncated: boolean;
}

/**
 * Given file content and a list of finding line ranges, extracts surrounding lines,
 * merges overlapping/adjacent line ranges to save tokens, and formats the code with
 * 1-based line numbers annotated.
 */
export function buildCodeContext(
  fileContent: string,
  findings: FindingLineRange[],
  options: ContextBuilderOptions
): CodeContextResult {
  if (!fileContent.length) {
    return { formattedContext: "(empty file)", mergedRanges: [], truncated: false };
  }

  // Split lines (handling \r\n or \n)
  const lines = fileContent.split(/\r?\n/);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return { formattedContext: "(empty file)", mergedRanges: [], truncated: false };
  }

  // 1. Expand each finding line range with surrounding lines and clamp to [1, totalLines]
  const expandedRanges: MergedRange[] = [];
  for (const f of findings) {
    const rawStart = f.lineStart;
    const rawEnd = f.lineEnd;

    // Clamp start and end
    const clampedStart = Math.min(Math.max(1, rawStart), totalLines);
    const clampedEnd = Math.min(Math.max(1, rawEnd), totalLines);

    // Ensure start <= end
    const validStart = Math.min(clampedStart, clampedEnd);
    const validEnd = Math.max(clampedStart, clampedEnd);

    const start = Math.max(1, validStart - options.surroundingLines);
    const end = Math.min(totalLines, validEnd + options.surroundingLines);

    expandedRanges.push({ start, end });
  }

  if (expandedRanges.length === 0) {
    return { formattedContext: "", mergedRanges: [], truncated: false };
  }

  // 2. Sort ranges by start line ascending
  expandedRanges.sort((a, b) => a.start - b.start);

  // 3. Merge overlapping or adjacent ranges (s2 <= e1 + 1)
  const mergedRanges: MergedRange[] = [];
  let currentRange = { ...expandedRanges[0]! };

  for (let i = 1; i < expandedRanges.length; i++) {
    const nextRange = expandedRanges[i]!;
    if (nextRange.start <= currentRange.end + 1) {
      // Overlapping or adjacent
      currentRange.end = Math.max(currentRange.end, nextRange.end);
    } else {
      mergedRanges.push(currentRange);
      currentRange = { ...nextRange };
    }
  }
  mergedRanges.push(currentRange);

  // 4. Format blocks with line numbers annotated
  const blocks: string[] = [];
  for (const range of mergedRanges) {
    const blockLines: string[] = [];
    for (let lineNum = range.start; lineNum <= range.end; lineNum++) {
      const lineText = lines[lineNum - 1] ?? "";
      blockLines.push(`${lineNum}: ${lineText}`);
    }
    blocks.push(blockLines.join("\n"));
  }

  let formattedContext = blocks.join("\n--- (omitted lines) ---\n");
  let truncated = false;

  // 5. Enforce maxLines cap if specified
  if (options.maxLines) {
    const allLines = formattedContext.split("\n");
    if (allLines.length > options.maxLines) {
      truncated = true;
      const keptLines = allLines.slice(0, options.maxLines);
      keptLines.push("[...context truncated due to max lines limit...]");
      formattedContext = keptLines.join("\n");
    }
  }

  // 6. Enforce maxBytes cap if specified
  if (options.maxBytes && Buffer.byteLength(formattedContext, "utf-8") > options.maxBytes) {
    const maxB = options.maxBytes;
    let currentBytes = 0;
    const truncatedLines: string[] = [];

    for (const line of formattedContext.split("\n")) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
      if (currentBytes + lineBytes > maxB) {
        truncated = true;
        truncatedLines.push("[...context truncated due to max size limits...]");
        break;
      }
      truncatedLines.push(line);
      currentBytes += lineBytes;
    }
    formattedContext = truncatedLines.join("\n");
  }

  return {
    formattedContext,
    mergedRanges,
    truncated,
  };
}
