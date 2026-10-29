import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightedSpans } from "./MarkdownCode.js";

function render(text: string, spans: number[], styles: string[]): string {
  return renderToStaticMarkup(<code>{highlightedSpans(text, { spans: Int32Array.from(spans), styles })}</code>);
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

describe("highlightedSpans", () => {
  it("renders styled tokens and keeps text the worker skipped", () => {
    const text = "const value = 1; // note";
    const html = render(
      text,
      [0, 5, 0, 6, 11, 1, 20, 26, 2],
      ["color:var(--syn-keyword)", "color:var(--syn-number)", "color:var(--syn-comment)"]
    );
    expect(textOf(html)).toBe(text);
    expect(html).toContain('style="color:var(--syn-keyword)"');
    expect(html).toContain('style="color:var(--syn-comment)"');
  });

  it("fills gaps and clamps spans that run past the text", () => {
    const text = "a b";
    const html = render(text, [0, 1, 0, 2, 10, 1], ["font-weight:600"]);
    expect(textOf(html)).toBe(text);
    expect(html).toContain("font-weight:600");
  });

  it("falls back to plain text without tokens", () => {
    expect(render("123", [], [])).toBe("<code>123</code>");
  });
});
