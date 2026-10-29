import { describe, expect, it } from "bun:test";
import { sandboxedPreviewDocument } from "./htmlPreview.js";

describe("sandboxedPreviewDocument", () => {
  it("embeds the html in a script-less sandboxed iframe", () => {
    const doc = sandboxedPreviewDocument("a.html", "<p>hi</p>");
    expect(doc).toContain('<iframe sandbox="allow-popups" srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe>');
    expect(doc).not.toContain("allow-scripts");
  });

  it("escapes quotes and markup so the html cannot break out of the attribute or title", () => {
    const doc = sandboxedPreviewDocument('</title><script>x()</script>', '"><script>alert(1)</script>&amp;');
    expect(doc).toContain("<title>&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;</title>");
    expect(doc).toContain('srcdoc="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;"');
    expect(doc).not.toContain("<script>");
  });
});
