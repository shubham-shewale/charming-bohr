import { describe, expect, it } from "vitest";
import { buildCodeContext } from "../llm/context-builder.js";

describe("buildCodeContext", () => {
  const sampleFileContent = Array.from({ length: 50 }, (_, i) => `line content ${i + 1}`).join("\n");

  it("handles a single finding with surrounding lines", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 10, lineEnd: 10 }],
      { surroundingLines: 2 }
    );

    expect(result.mergedRanges).toEqual([{ start: 8, end: 12 }]);
    expect(result.formattedContext).toContain("8: line content 8");
    expect(result.formattedContext).toContain("10: line content 10");
    expect(result.formattedContext).toContain("12: line content 12");
    expect(result.formattedContext).not.toContain("7: line content 7");
    expect(result.formattedContext).not.toContain("13: line content 13");
  });

  it("merges overlapping line ranges", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [
        { lineStart: 10, lineEnd: 12 },
        { lineStart: 13, lineEnd: 15 },
      ],
      { surroundingLines: 2 }
    );

    // Range 1 expanded: 8..14
    // Range 2 expanded: 11..17
    // Merged: 8..17
    expect(result.mergedRanges).toEqual([{ start: 8, end: 17 }]);
    expect(result.formattedContext).not.toContain("--- (omitted lines) ---");
    expect(result.formattedContext).toContain("8: line content 8");
    expect(result.formattedContext).toContain("17: line content 17");
  });

  it("merges adjacent ranges", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [
        { lineStart: 1, lineEnd: 2 },
        { lineStart: 3, lineEnd: 4 },
      ],
      { surroundingLines: 0 }
    );

    // Range 1: 1..2
    // Range 2: 3..4
    // Merged: 1..4 (since 3 <= 2 + 1)
    expect(result.mergedRanges).toEqual([{ start: 1, end: 4 }]);
    expect(result.formattedContext).toContain("1: line content 1");
    expect(result.formattedContext).toContain("4: line content 4");
    expect(result.formattedContext).not.toContain("--- (omitted lines) ---");
  });

  it("clamps finding at line 1 correctly", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 1, lineEnd: 2 }],
      { surroundingLines: 5 }
    );

    // Expanded 1-5..2+5 => -4..7 => clamped to 1..7
    expect(result.mergedRanges).toEqual([{ start: 1, end: 7 }]);
    expect(result.formattedContext).toContain("1: line content 1");
    expect(result.formattedContext).toContain("7: line content 7");
  });

  it("clamps finding at EOF correctly", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 49, lineEnd: 50 }],
      { surroundingLines: 5 }
    );

    // Expanded 49-5..50+5 => 44..55 => clamped to 44..50
    expect(result.mergedRanges).toEqual([{ start: 44, end: 50 }]);
    expect(result.formattedContext).toContain("44: line content 44");
    expect(result.formattedContext).toContain("50: line content 50");
    expect(result.formattedContext).not.toContain("51: line content 51");
  });

  it("handles line numbers that exceed file length gracefully", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 100, lineEnd: 120 }],
      { surroundingLines: 2 }
    );

    // Clamped to 50..50
    expect(result.mergedRanges).toEqual([{ start: 48, end: 50 }]);
    expect(result.formattedContext).toContain("50: line content 50");
  });

  it("truncates when context size exceeds maxBytes cap", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 1, lineEnd: 50 }],
      { surroundingLines: 0, maxBytes: 150 }
    );

    expect(result.truncated).toBe(true);
    expect(result.formattedContext).toContain("[...context truncated due to max size limits...]");
  });

  it("truncates when context lines exceed maxLines cap", () => {
    const result = buildCodeContext(
      sampleFileContent,
      [{ lineStart: 1, lineEnd: 50 }],
      { surroundingLines: 0, maxLines: 10 }
    );

    expect(result.truncated).toBe(true);
    expect(result.formattedContext).toContain("[...context truncated due to max lines limit...]");
  });
});
