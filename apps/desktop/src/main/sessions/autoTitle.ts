import { sanitizeGeneratedBranch } from "./branchName.js";

const MAX_PROMPT_MESSAGE_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

const LEADING_TITLE_NOISE = /^[*_`"'“”‘’„«»]+/;
const TRAILING_TITLE_NOISE = /[*_#`"'“”‘’„«»]+$/;
const LINE_LABEL = /^\s*[*_]*(?:title|branch(?:\s+name)?)[*_]*\s*[:=]\s*/i;

export const AUTO_TITLE_TIMEOUT_MS = 45_000;

export interface MetadataInstructions {
  title?: string;
  branch?: string;
}

export interface GeneratedMetadata {
  title: string;
  branch: string | null;
}

export function buildTitlePrompt(firstMessage: string, instructions: MetadataInstructions = {}): string {
  const message = firstMessage.trim().slice(0, MAX_PROMPT_MESSAGE_CHARS);
  const title = instructions.title?.trim();
  const branch = instructions.branch?.trim();
  const lines = branch
    ? [
        "Classify the work in the user's first message and answer with a short session title and a git branch name.",
        "Title rules: 3-6 words, no quotes, no markdown, no trailing punctuation, same language as the message.",
        ...(title ? [`Project title instructions: ${title}`] : []),
        "Branch rules: a valid git branch name with no spaces.",
        `Project branch instructions: ${branch}`,
        "Reply with exactly two lines and no labels: the title on the first line, the branch name on the second."
      ]
    : [
        "Classify the work in the user's first message and answer with a short session title.",
        "Rules: 3-6 words, no quotes, no markdown, no trailing punctuation, same language as the message.",
        ...(title ? [`Project title instructions: ${title}`] : []),
        "Reply with the title only."
      ];
  return [...lines, "", "User's first message:", message].join("\n");
}

export function sanitizeGeneratedTitle(raw: string): string {
  const line = raw.split(/\r\n|\r|\n/).find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    return "";
  }
  let title = line.trim();
  for (;;) {
    const stripped = title
      .replace(/^(?:[#>\s]+|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(LEADING_TITLE_NOISE, "")
      .replace(TRAILING_TITLE_NOISE, "")
      .replace(/[.:;,]+$/, "")
      .trim();
    if (stripped === title) {
      break;
    }
    title = stripped;
  }
  return title.replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS).trim();
}

export function parseGeneratedMetadata(raw: string, expectBranch: boolean): GeneratedMetadata {
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(LINE_LABEL, ""))
    .filter((line) => line.trim().length > 0);
  const title = sanitizeGeneratedTitle(lines[0] ?? "");
  return { title, branch: expectBranch ? sanitizeGeneratedBranch(lines[1] ?? "") : null };
}
