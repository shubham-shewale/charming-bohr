import fs from "node:fs";
import { parse } from "csv-parse";
import { parseScmLink } from "../parsers/index.js";
import type {
  CanonicalSource,
  FileWorkItem,
  FindingRef,
  FindingStatus,
  ParseError,
  ScmParseResult,
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
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, "");
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
  let rowIndex = 0;

  for await (const record of parser) {
    if (headers.length === 0) {
      headers = Object.keys(record);
      scmHeader = findScmLinkHeader(headers);
      statusHeader = findStatusHeader(headers);
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
      } else if (existingStatus === "skipped") {
        initialStatus = "skipped";
      }
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
      sourceFile: filePath,
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
    const key = getContentIdentity(source);

    let item = map.get(key);
    if (!item) {
      item = {
        contentIdentity: key,
        provider: source.provider,
        org: source.org,
        project: source.project,
        repo: source.repo,
        revision: source.revision,
        filePath: source.filePath,
        findings: [],
      };
      map.set(key, item);
    }
    item.findings.push(finding);
  }

  return map;
}
