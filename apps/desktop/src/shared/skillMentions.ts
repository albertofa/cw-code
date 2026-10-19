const SKILL_MENTION_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const MAX_SKILL_MENTIONS = 32;

const QUERY = /^[A-Za-z0-9:_-]*$/;
const MONEY = /^[0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$/;
const MENTION_END = /[\s.,;!?)\]}"'`]/;
const TRAILING_SEPARATORS = /[:_-]+$/;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const CANDIDATE = /(^|\s)\$([A-Za-z0-9][A-Za-z0-9:_-]*)/g;
const REFERENCE = /(^|\s)[$/]([A-Za-z0-9][A-Za-z0-9:_-]*)/g;

export interface SkillMention {
  name: string;
  start: number;
  end: number;
}

export interface SkillTrigger {
  start: number;
  end: number;
  query: string;
}

export interface SkillInvocation {
  name: string;
  args: string;
}

function codeRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(CODE)].map((match) => [match.index, match.index + match[0].length]);
}

function insideCode(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function knownName(raw: string, known: ReadonlySet<string>): string | null {
  if (known.has(raw)) return raw;
  const trimmed = raw.replace(TRAILING_SEPARATORS, "");
  return trimmed && known.has(trimmed) ? trimmed : null;
}

export function findSkillMentions(text: string, known: ReadonlySet<string>): SkillMention[] {
  return findSkillTokens(text, known, CANDIDATE);
}

export function findSkillReferences(text: string, known: ReadonlySet<string>): SkillMention[] {
  return findSkillTokens(text, known, REFERENCE);
}

function findSkillTokens(text: string, known: ReadonlySet<string>, pattern: RegExp): SkillMention[] {
  if (known.size === 0) return [];
  const code = codeRanges(text);
  const out: SkillMention[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    const raw = match[2];
    const rawEnd = start + 1 + raw.length;
    if (rawEnd < text.length && !MENTION_END.test(text[rawEnd])) continue;
    const name = knownName(raw, known);
    if (!name || insideCode(code, start)) continue;
    out.push({ name, start, end: start + 1 + name.length });
  }
  return out;
}

export function skillMentionNames(text: string, known: ReadonlySet<string>): string[] {
  return [...new Set(findSkillMentions(text, known).map((mention) => mention.name))].slice(0, MAX_SKILL_MENTIONS);
}

export function hasSkillCandidate(text: string): boolean {
  if (!text.includes("$")) return false;
  const code = codeRanges(text);
  return [...text.matchAll(CANDIDATE)].some(
    (match) => !MONEY.test(match[2]) && !insideCode(code, match.index + match[1].length)
  );
}

export function detectSkillTrigger(text: string, caret: number): SkillTrigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  if (caret <= start || text[start] !== "$") return null;
  const query = text.slice(start + 1, caret);
  if (!QUERY.test(query) || MONEY.test(query)) return null;
  if (insideCode(codeRanges(text), start)) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end, query };
}

export function insertSkillMention(text: string, trigger: SkillTrigger, name: string): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const mention = `$${name}${/^\s/.test(after) ? "" : " "}`;
  return { text: `${text.slice(0, trigger.start)}${mention}${after}`, caret: trigger.start + name.length + 2 };
}

export function insertSkillTrigger(text: string, caret: number): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const prefix = before === "" || /\s$/.test(before) ? "$" : " $";
  return { text: `${before}${prefix}${text.slice(caret)}`, caret: caret + prefix.length };
}

/** For harnesses that only run a single leading `/name` per message. */
export function skillInvocation(prompt: string, skills: readonly string[]): SkillInvocation | null {
  if (prompt.trimStart().startsWith("/")) return null;
  const mentions = findSkillMentions(prompt, new Set(skills));
  const first = mentions[0];
  if (!first) return null;
  const leads = prompt.slice(0, first.start).trim() === "";
  let args = prompt;
  for (const mention of [...mentions].reverse()) {
    const replacement = mention === first && leads ? "" : `/${mention.name}`;
    args = `${args.slice(0, mention.start)}${replacement}${args.slice(mention.end)}`;
  }
  return { name: first.name, args: args.trim() };
}

export function isSkillMentionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SKILL_MENTIONS &&
    value.every((name) => typeof name === "string" && SKILL_MENTION_NAME.test(name))
  );
}
