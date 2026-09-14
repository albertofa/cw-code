const MAX_PROMPT_MESSAGE_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

const LEADING_TITLE_NOISE = /^[*_`"'\u201c\u201d\u2018\u2019\u201e\u00ab\u00bb]+/;
const TRAILING_TITLE_NOISE = /[*_#`"'\u201c\u201d\u2018\u2019\u201e\u00ab\u00bb]+$/;

export const AUTO_TITLE_TIMEOUT_MS = 45_000;

export function buildTitlePrompt(firstMessage: string): string {
  const message = firstMessage.trim().slice(0, MAX_PROMPT_MESSAGE_CHARS);
  return [
    "Classify the work in the user's first message and answer with a short session title.",
    "Rules: 3-6 words, no quotes, no markdown, no trailing punctuation, same language as the message.",
    "Reply with the title only.",
    "",
    "User's first message:",
    message,
  ].join("\n");
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
