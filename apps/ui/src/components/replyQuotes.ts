/** Quoted excerpts travel as Markdown blockquotes at the top of the prompt, so every CLI reads them as plain text. */

export function cleanQuote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatQuotedReply(quotes: readonly string[], body: string): string {
  const blocks = quotes
    .map(cleanQuote)
    .filter((quote) => quote !== "")
    .map((quote) =>
      quote
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n")
    );
  if (blocks.length === 0) return body;
  return body === "" ? blocks.join("\n\n") : `${blocks.join("\n\n")}\n\n${body}`;
}

/** Splits the leading blockquotes written by `formatQuotedReply` from the rest of a prompt. */
export function splitQuotedReply(text: string): { quotes: string[]; body: string } {
  const lines = text.split("\n");
  const quotes: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) {
    const block: string[] = [];
    while (index < lines.length && lines[index].startsWith(">")) {
      block.push(lines[index].replace(/^> ?/, ""));
      index += 1;
    }
    quotes.push(block.join("\n"));
    if (index < lines.length && lines[index] === "" && lines[index + 1]?.startsWith(">")) index += 1;
  }
  if (quotes.length === 0) return { quotes, body: text };
  if (lines[index] === "") index += 1;
  return { quotes, body: lines.slice(index).join("\n") };
}
