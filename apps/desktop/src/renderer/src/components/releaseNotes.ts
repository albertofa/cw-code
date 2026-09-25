const HTML_TAG_RE = /<\/?(?:p|div|br|h[1-6]|ul|ol|li|a|strong|em|b|i|code|pre|blockquote|span|img|hr|table|thead|tbody|tr|td|th)\b[^>]*>/i;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const MAX_CODE_POINT = 0x10ffff;

export function isHttpsLink(href: string): boolean {
  if (!/^https:\/\//i.test(href)) return false;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

export function looksLikeHtml(text: string): boolean {
  return HTML_TAG_RE.test(text);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const value = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_CODE_POINT || value === 0xfffe) return match;
      return String.fromCodePoint(value);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function markdownLink(rawHref: string, innerHtml: string): string {
  const label = decodeEntities(stripTags(innerHtml)).replace(/\s+/g, " ").trim();
  const href = decodeEntities(rawHref).trim();
  if (!label) return "";
  if (!isHttpsLink(href) || /[\s()<>[\]]/.test(href)) return label;
  return `[${label.replace(/[[\]\\]/g, "\\$&")}](${href})`;
}

function htmlToText(html: string): string {
  const withLinks = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, double: string | undefined, single: string | undefined, inner: string) =>
      markdownLink(double ?? single ?? "", inner)
    )
    .replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? "");
  const structured = withLinks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|h[1-6]|ul|ol|blockquote|pre|table|tr)\s*>/gi, "\n\n")
    .replace(/<(?:p|div|ul|ol|blockquote|pre|table|tr)\b[^>]*>/gi, "\n\n");
  const lines = decodeEntities(stripTags(structured))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const tight = lines.filter((line, index) => {
    if (line !== "") return true;
    const before = lines.slice(0, index).reverse().find((candidate) => candidate !== "");
    const after = lines.slice(index + 1).find((candidate) => candidate !== "");
    return !(before?.startsWith("- ") && after?.startsWith("- "));
  });
  return tight.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function releaseNotesMarkdown(notes: string | null): string | null {
  if (notes === null) return null;
  const text = looksLikeHtml(notes) ? htmlToText(notes) : notes.trim();
  return text.length > 0 ? text : null;
}
