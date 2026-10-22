// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildTextIndex, chunkAt, findMatches, rangeForSpan, snippet } from "./threadFind.js";

function host(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("findMatches", () => {
  it("finds every non-overlapping match, case-insensitively", () => {
    expect(findMatches("Deploy the deployment", "deploy")).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 }
    ]);
  });

  it("does not loop on repeated matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 }
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });
});

describe("buildTextIndex", () => {
  it("joins inline markup so a word split across tags still matches", () => {
    const index = buildTextIndex(host("<p>re<strong>fac</strong>tor</p>"));
    expect(index.text.trim()).toBe("refactor");
    expect(findMatches(index.text, "refactor")).toHaveLength(1);
  });

  it("breaks between block elements so neighbours do not merge into a false match", () => {
    const index = buildTextIndex(host("<div>end</div><div>point</div>"));
    expect(findMatches(index.text, "endpoint")).toEqual([]);
  });

  it("skips decorative and non-text nodes", () => {
    const index = buildTextIndex(host('<p>visible</p><span aria-hidden="true">icon</span><script>hidden()</script>'));
    expect(index.text).toContain("visible");
    expect(index.text).not.toContain("icon");
    expect(index.text).not.toContain("hidden()");
  });

  it("indexes text inside collapsed turns", () => {
    const index = buildTextIndex(host('<div class="turn-fold" hidden><p>inside a collapsed step</p></div>'));
    expect(findMatches(index.text, "collapsed step")).toHaveLength(1);
  });
});

describe("rangeForSpan", () => {
  it("maps a match back to a range that spans several text nodes", () => {
    const root = host("<p>re<strong>fac</strong>tor</p>");
    const index = buildTextIndex(root);
    const [span] = findMatches(index.text, "refactor");
    const range = rangeForSpan(index, span);
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe("refactor");
  });

  it("maps a match inside a single node", () => {
    const root = host("<p>rollback the migration</p>");
    const index = buildTextIndex(root);
    const [span] = findMatches(index.text, "migration");
    expect(rangeForSpan(index, span)?.toString()).toBe("migration");
  });
});

describe("chunkAt", () => {
  it("returns -1 when there is nothing indexed", () => {
    expect(chunkAt([], 3)).toBe(-1);
  });
});

describe("snippet", () => {
  it("collapses whitespace and truncates", () => {
    expect(snippet("  a\n\n  long    prompt  ", 8)).toBe("a long …");
  });
});
