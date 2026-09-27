const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi,
    (match, code: string) => {
      if (code[0] === "#") {
        const codePoint =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return Number.isNaN(codePoint)
          ? match
          : String.fromCodePoint(codePoint);
      }
      const key = code.toLowerCase();
      return NAMED_ENTITIES[key] ?? match;
    },
  );
}

/** Markdown link `[text](url)` -> `text (url)`. */
function unwrapLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}

/** Drops separator rows like `---`, `---|---`, `| | |` and strips leading/trailing `|` per line. */
function stripTableMarkup(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^[\s|:-]+$/.test(line) || line.trim() === "")
    .map((line) => line.replace(/^(\s*\|\s*)+/, "").replace(/(\s*\|\s*)+$/, ""))
    .join("\n");
}

/**
 * Normalizes email bodies for display. Handles two upstream artifact sources:
 * ATS/notification senders (e.g. Paradox/Olivia) whose "text/plain" MIME part is itself
 * Markdown-ish (table pipes, separator rows, `[text](url)` links), and leftover HTML
 * entities that `stripHtml` in gmail-client.ts never decodes.
 */
export function formatBodyText(rawText: string): string {
  const normalizedNewlines = rawText.replace(/\r\n/g, "\n");
  const withoutTables = stripTableMarkup(normalizedNewlines);
  const withoutLinks = unwrapLinks(withoutTables);
  const decoded = decodeEntities(withoutLinks);
  return decoded
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
