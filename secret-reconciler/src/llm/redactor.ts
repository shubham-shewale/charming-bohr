const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|connection[_-]?string)/i;

const WELL_KNOWN_SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(["'])[A-Za-z0-9+/_=-]{20,}\1/g,
];

function redactAssignment(line: string): string {
  const separator = line.search(/[:=]/);
  if (separator < 0) return line;

  const key = line.slice(0, separator);
  if (!SENSITIVE_KEY_PATTERN.test(key)) return line;

  const prefix = line.slice(0, separator + 1);
  const suffix = line.slice(separator + 1);
  const commentIndex = suffix.search(/\s(?:#|\/\/)/);
  const comment = commentIndex >= 0 ? suffix.slice(commentIndex) : "";
  return `${prefix} <REDACTED_SECRET>${comment}`;
}

/** Redacts likely credential material before source context reaches the gateway. */
export function redactSensitiveContent(content: string): string {
  let inPrivateKey = false;
  return content
    .split(/\r?\n/)
    .map((originalLine) => {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(originalLine)) {
        inPrivateKey = true;
        return "<REDACTED_PRIVATE_KEY_BLOCK>";
      }
      if (inPrivateKey) {
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(originalLine)) {
          inPrivateKey = false;
        }
        return "";
      }

      let line = redactAssignment(originalLine);
      for (const pattern of WELL_KNOWN_SECRET_PATTERNS) {
        line = line.replace(pattern, "<REDACTED_SECRET>");
      }
      return line;
    })
    .join("\n");
}

/**
 * Redacts all scalar assignment values on the focal finding lines. This is a
 * final containment layer for detector formats unknown to the generic redactor.
 */
export function redactFocalValues(
  content: string,
  lineStart: number,
  lineEnd: number
): string {
  const lines = content.split(/\r?\n/);
  for (let number = Math.max(1, lineStart); number <= lineEnd; number++) {
    const index = number - 1;
    const line = lines[index];
    if (line === undefined) continue;
    const separator = line.search(/[:=]/);
    if (separator >= 0) {
      lines[index] = `${line.slice(0, separator + 1)} <REDACTED_SECRET>`;
    } else if (line.trim().length > 0) {
      lines[index] = `${line.match(/^\s*/)?.[0] ?? ""}<REDACTED_SECRET>`;
    }
  }
  return lines.join("\n");
}
