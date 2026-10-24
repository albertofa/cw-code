const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_FRONTMATTER_VALUE_LENGTH = 4096;
const MAX_FRONTMATTER_ENTRIES = 64;

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, string>;
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return inner;
    }
  }
  return trimmed;
}

function parseFrontmatterBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!key || key.includes(" ") || key.includes("\t")) continue;
    if (Object.keys(out).length >= MAX_FRONTMATTER_ENTRIES) break;
    out[key] = unquote(trimmed.slice(colon + 1)).slice(0, MAX_FRONTMATTER_VALUE_LENGTH);
  }
  return out;
}

function splitFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return { frontmatter: {}, body: content };
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      closing = i;
      break;
    }
  }
  if (closing < 0) return { frontmatter: {}, body: content };
  return {
    frontmatter: parseFrontmatterBlock(lines.slice(1, closing).join("\n")),
    body: lines.slice(closing + 1).join("\n").replace(/^\n+/, "")
  };
}

export function firstParagraph(body: string): string {
  const normalized = normalizeNewlines(body);
  for (const block of normalized.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue;
    const collapsed = trimmed.replace(/\s+/g, " ");
    if (collapsed) return collapsed.slice(0, MAX_DESCRIPTION_LENGTH);
  }
  return "";
}

export function parseSkillFile(content: string, fallbackName: string): ParsedSkill {
  const normalized = normalizeNewlines(content);
  const { frontmatter, body } = splitFrontmatter(normalized);
  const rawName = (frontmatter["name"] ?? "").trim();
  const name = (rawName || fallbackName.trim()).slice(0, MAX_NAME_LENGTH);
  const rawDescription = (frontmatter["description"] ?? "").trim();
  const description = (rawDescription || firstParagraph(body)).slice(0, MAX_DESCRIPTION_LENGTH);
  return { name, description, body, frontmatter };
}

function yamlEscape(value: string): string {
  if (value === "") return '""';
  if (/[\n:{}#\[\],&*!|>'"%@`]/.test(value) || /^\s|\s$/.test(value) || /:\s/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

export function serializeSkillFile(frontmatter: Record<string, string>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!key || key.includes(" ") || key.includes(":") || key.includes("\n")) continue;
    lines.push(`${key}: ${yamlEscape(value)}`);
  }
  lines.push("---", "");
  const normalizedBody = normalizeNewlines(body).replace(/^\n+/, "");
  return `${lines.join("\n")}${normalizedBody}${normalizedBody.endsWith("\n") ? "" : "\n"}`;
}
