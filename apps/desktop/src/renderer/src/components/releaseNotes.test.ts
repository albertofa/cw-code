import { describe, expect, it } from "vitest";
import { isHttpsLink, looksLikeHtml, releaseNotesMarkdown } from "./releaseNotes.js";

describe("releaseNotesMarkdown", () => {
  it("keeps plain markdown notes as they are", () => {
    expect(releaseNotesMarkdown("## 1.1.0\n\n- Faster startup\n")).toBe("## 1.1.0\n\n- Faster startup");
    expect(releaseNotesMarkdown(null)).toBeNull();
    expect(releaseNotesMarkdown("   ")).toBeNull();
  });

  it("converts GitHub Atom HTML into text with headings, lists and https links", () => {
    const html =
      '<h2>What&#39;s Changed</h2>\n<ul>\n<li>Fix the <strong>quit</strong> dialog by <a href="https://github.com/octo">@octo</a> in <a href="https://github.com/albertofa/cw-code/pull/12">#12</a></li>\n<li>Faster &amp; smaller</li>\n<li>Third</li>\n</ul>\n<p><strong>Full Changelog</strong>: <a href="https://github.com/albertofa/cw-code/compare/v1.0.0...v1.1.0"><tt>v1.0.0...v1.1.0</tt></a></p>';
    expect(releaseNotesMarkdown(html)).toBe(
      [
        "## What's Changed",
        "",
        "- Fix the quit dialog by [@octo](https://github.com/octo) in [#12](https://github.com/albertofa/cw-code/pull/12)",
        "- Faster & smaller",
        "- Third",
        "",
        "Full Changelog: [v1.0.0...v1.1.0](https://github.com/albertofa/cw-code/compare/v1.0.0...v1.1.0)"
      ].join("\n")
    );
  });

  it("drops scripts, styles, comments and non-https links, keeping only their visible text", () => {
    const html =
      '<p>Hi<script>alert(1)</script><style>p{}</style><!-- secret --></p><p><a href="javascript:alert(1)">click</a> <a href="http://example.com">plain</a> <a href=\'file:///C:/x\'>file</a></p><img src="https://tracker.example/pixel.png" alt="diagram">';
    const text = releaseNotesMarkdown(html) ?? "";
    expect(text).toBe("Hi\n\nclick plain file\n\ndiagram");
    expect(text).not.toMatch(/alert|secret|javascript|http:|file:|tracker/);
  });

  it("decodes entities to literal text and never produces markup-bearing links", () => {
    const text = releaseNotesMarkdown('<p>&lt;Component&gt; &#x1F680; &bogus; &#0;</p><p><a href="https://example.com/a b">spaced</a></p>') ?? "";
    expect(text).toBe("<Component> \u{1F680} &bogus; &#0;\n\nspaced");
  });

  it("escapes brackets in link labels", () => {
    expect(releaseNotesMarkdown('<p><a href="https://example.com">[beta] notes</a></p>')).toBe("[\\[beta\\] notes](https://example.com)");
  });
});

describe("isHttpsLink", () => {
  it("accepts only well-formed https URLs", () => {
    expect(isHttpsLink("https://github.com/albertofa/cw-code")).toBe(true);
    expect(isHttpsLink("HTTPS://github.com")).toBe(true);
    for (const href of ["http://github.com", "javascript:alert(1)", "file:///C:/x", "mailto:a@b.c", "//github.com", "https://", "notes.md"]) {
      expect(isHttpsLink(href)).toBe(false);
    }
  });
});

describe("looksLikeHtml", () => {
  it("detects the tags the release feed uses and ignores markdown", () => {
    expect(looksLikeHtml("<p>x</p>")).toBe(true);
    expect(looksLikeHtml("Use a <br/> here")).toBe(true);
    expect(looksLikeHtml("Compare a < b and Vec<T>")).toBe(false);
  });
});
