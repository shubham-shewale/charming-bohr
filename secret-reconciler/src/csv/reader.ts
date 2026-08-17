import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { parseScmLink } from "../parsers/index.js";
import type {
  CanonicalSource,
  FileWorkItem,
  FindingRef,
  FindingResult,
  FindingStatus,
  LlmClassification,
  ParseError,
  ScmParseResult,
  TruffleHogResult,
} from "../types.js";

/**
 * Computes the unique Content Identity for a CanonicalSource.
 * Content Identity = provider::org/repo::revision::filePath
 * or provider::org/project/repo::revision::filePath (for Azure DevOps)
 * @see CONTEXT.md — Content Identity
 */
export function getContentIdentity(source: CanonicalSource): string {
  const repoScope = source.project ? `${source.org}/${source.project}/${source.repo}` : `${source.org}/${source.repo}`;
  return `${source.provider}::${repoScope}::${source.revision}::${source.filePath}`;
}

/**
 * Options for reading a CSV finding file.
 */
export interface ReadCsvOptions {
  /** If true, re-process findings previously marked with status=failed. */
  retryFailed?: boolean;
}

/**
 * Result returned by {@link readFindingsCsv}.
 */
export interface ReadCsvResult {
  findings: FindingRef[];
  /** Preserved original headers in exact order as read from the CSV. */
  headers: string[];
}

/**
 * Normalizes header string for comparison.
 */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, "");
}

/**
 * Merges multiple header lists preserving first-seen order and normalized uniqueness.
 */
export function mergeHeaders(
  ...headerLists: (string[] | readonly string[])[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of headerLists) {
    for (const h of list) {
      const norm = normalizeHeader(h);
      if (!seen.has(norm)) {
        seen.add(norm);
        result.push(h);
      }
    }
  }
  return result;
}

/**
 * Finds the header name matching SCM link across common column variants.
 */
function findScmLinkHeader(headers: string[]): string | undefined {
  const normalized = headers.map((h) => ({ original: h, norm: normalizeHeader(h) }));

  // Primary choices: scmlink, scmlinkurl, scmurl
  const primary = normalized.find(
    (item) =>
      item.norm === "scmlink" ||
      item.norm === "scmlinkurl" ||
      item.norm === "scmurl"
  );
  if (primary) return primary.original;

  // Secondary choices: sourcelink, repolink
  const secondary = normalized.find(
    (item) => item.norm === "sourcelink" || item.norm === "repolink"
  );
  if (secondary) return secondary.original;

  // Fallback choices: url, link
  const fallback = normalized.find(
    (item) => item.norm === "url" || item.norm === "link"
  );
  if (fallback) return fallback.original;

  return undefined;
}

/**
 * Finds the header name for the status column if it exists.
 */
function findStatusHeader(headers: string[]): string | undefined {
  return headers.find((h) => normalizeHeader(h) === "status");
}

/**
 * Finds the header name for the source_file column if it exists.
 */
function findSourceFileHeader(headers: string[]): string | undefined {
  return headers.find((h) => normalizeHeader(h) === "sourcefile");
}

/**
 * Stream-reads a CSV file, dynamically discovers headers, parses SCM links,
 * and normalizes rows into {@link FindingRef} objects.
 */
export async function readFindingsCsv(
  filePath: string,
  options: ReadCsvOptions = {}
): Promise<ReadCsvResult> {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });

  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  fileStream.pipe(parser);

  const findings: FindingRef[] = [];
  let headers: string[] = [];
  let scmHeader: string | undefined;
  let statusHeader: string | undefined;
  let sourceFileHeader: string | undefined;
  let rowIndex = 0;

  for await (const record of parser) {
    if (headers.length === 0) {
      headers = Object.keys(record);
      scmHeader = findScmLinkHeader(headers);
      statusHeader = findStatusHeader(headers);
      sourceFileHeader = findSourceFileHeader(headers);
    }

    const rawRow: Record<string, string> = record;
    let initialStatus: FindingStatus = "pending";

    // ── Check resume status if status column exists (ADR 0002) ──────────
    if (statusHeader && rawRow[statusHeader]) {
      const existingStatus = rawRow[statusHeader].trim().toLowerCase();
      if (existingStatus === "completed") {
        initialStatus = "completed";
      } else if (existingStatus === "failed") {
        initialStatus = options.retryFailed ? "pending" : "failed";
      } else {
        // "pending", "skipped", empty status, or other values are always processed
        initialStatus = "pending";
      }
    }

    // Determine source_file: preserve existing if present and non-empty, otherwise use filename
    let sourceFile = path.basename(filePath);
    if (sourceFileHeader && rawRow[sourceFileHeader] && rawRow[sourceFileHeader].trim()) {
      sourceFile = rawRow[sourceFileHeader].trim();
    }

    const rawUrl = scmHeader ? rawRow[scmHeader] : undefined;

    let canonicalSource: CanonicalSource | undefined;
    let parseError: ParseError | undefined;

    if (!rawUrl) {
      parseError = {
        kind: "unsupported-host",
        message: "No SCM link URL found in row.",
        rawUrl: "",
      };
      if (initialStatus === "pending") {
        initialStatus = "skipped";
      }
    } else {
      const parseRes: ScmParseResult = parseScmLink(rawUrl);
      if (parseRes.ok) {
        canonicalSource = parseRes.value;
      } else {
        parseError = parseRes.error;
        if (initialStatus === "pending") {
          initialStatus = "skipped";
        }
      }
    }

    findings.push({
      rowIndex,
      sourceFile,
      rawRow,
      canonicalSource,
      parseError,
      initialStatus,
    });

    rowIndex++;
  }

  return { findings, headers };
}

/**
 * Builds a FindingResult for a non-pending finding row preserving rawRow values.
 */
export function buildNonPendingFindingResult(finding: FindingRef): FindingResult {
  const getRaw = (colName: string): string => {
    const norm = normalizeHeader(colName);
    for (const key of Object.keys(finding.rawRow)) {
      if (normalizeHeader(key) === norm) {
        return finding.rawRow[key] ?? "";
      }
    }
    return "";
  };

  const rawConfidence = getRaw("llm_confidence");
  const rawClassification = getRaw("llm_classification");
  const rawError = getRaw("error");
  const rawDetector = getRaw("trufflehog_detector");
  const rawResult = getRaw("trufflehog_result");
  const rawReason = getRaw("llm_reason");

  return {
    findingRef: finding,
    status: finding.initialStatus,
    trufflehogResult: (rawResult as TruffleHogResult) || "",
    trufflehogDetector: rawDetector,
    llmClassification: (rawClassification as LlmClassification) || undefined,
    llmReason: rawReason,
    llmConfidence: rawConfidence ? Number(rawConfidence) : undefined,
    error: rawError || finding.parseError?.message || "",
  };
}

/**
 * Groups findings with `initialStatus === "pending"` by Content Identity into a Map of FileWorkItems.
 */
export function groupFindingsByContentIdentity(
  findings: FindingRef[]
): Map<string, FileWorkItem> {
  const map = new Map<string, FileWorkItem>();

  for (const finding of findings) {
    if (!finding.canonicalSource || finding.initialStatus !== "pending") {
      continue;
    }

    const source = finding.canonicalSource;
    const contentIdentity = getContentIdentity(source);

    let item = map.get(contentIdentity);
    if (!item) {
      item = {
        contentIdentity,
        provider: source.provider,
        org: source.org,
        project: source.project,
        repo: source.repo,
        revision: source.revision,
        filePath: source.filePath,
        findings: [],
      };
      map.set(contentIdentity, item);
    }
    item.findings.push(finding);
  }

  return map;
}
