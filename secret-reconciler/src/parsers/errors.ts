import type { ParseError } from "../types.js";

// A commit SHA is exactly 40 lowercase hexadecimal characters.
export const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Creates a structured ParseError result for SCM link parsing.
 */
export function createParseError(
  kind: ParseError["kind"],
  message: string,
  rawUrl: string
): { ok: false; error: ParseError } {
  return { ok: false, error: { kind, message, rawUrl } };
}
