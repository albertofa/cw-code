import { describe, expect, it } from "vitest";
import {
  buildPreviewHtml,
  isAbsolutePath,
  isGitHubLink,
  isHttpLink,
  isLocalPreviewLink,
  isPathInsideBase,
  isPreviewablePath,
  resolvePreviewPaths,
  sanitizeStreamingMarkdown
} from "./Markdown.js";

describe("isPreviewablePath", () => {
  it("accepts markdown and html extensions", () => {
    expect(isPreviewablePath("docs/a.md")).toBe(true);
    expect(isPreviewablePath("a.MARKDOWN")).toBe(true);
    expect(isPreviewablePath("x.html")).toBe(true);
    expect(isPreviewablePath("x.htm")).toBe(true);
  });

  it("rejects other files", () => {
    expect(isPreviewablePath("a.ts")).toBe(false);
    expect(isPreviewablePath("noext")).toBe(false);
  });
});

describe("isLocalPreviewLink", () => {
  it("accepts local markdown/html links", () => {
    expect(isLocalPreviewLink("docs/a.md")).toBe(true);
    expect(isLocalPreviewLink("./a.md")).toBe(true);
    expect(isLocalPreviewLink("/abs/a.html")).toBe(true);
    expect(isLocalPreviewLink("C:\\proj\\a.md")).toBe(true);
    expect(isLocalPreviewLink("a.md#section")).toBe(true);
  });

  it("rejects remote and non-preview links", () => {
    expect(isLocalPreviewLink("https://x.com/a.md")).toBe(false);
    expect(isLocalPreviewLink("mailto:a@b.c")).toBe(false);
    expect(isLocalPreviewLink("//x.com/a.md")).toBe(false);
    expect(isLocalPreviewLink("a.ts")).toBe(false);
    expect(isLocalPreviewLink("#frag")).toBe(false);
  });
});

describe("isHttpLink / isGitHubLink", () => {
  it("detects http(s) links only", () => {
    expect(isHttpLink("https://example.com/x")).toBe(true);
    expect(isHttpLink("http://example.com/x")).toBe(true);
    expect(isHttpLink("mailto:a@b.c")).toBe(false);
    expect(isHttpLink("docs/a.md")).toBe(false);
  });

  it("detects GitHub hosts", () => {
    expect(isGitHubLink("https://github.com/org/repo/pull/15")).toBe(true);
    expect(isGitHubLink("https://www.github.com/org/repo")).toBe(true);
    expect(isGitHubLink("https://gist.github.com/user/abc")).toBe(true);
    expect(isGitHubLink("https://gitlab.com/org/repo")).toBe(false);
    expect(isGitHubLink("https://github.com.evil.test/org")).toBe(false);
    expect(isGitHubLink("not a url")).toBe(false);
  });
});

describe("resolvePreviewPaths", () => {
  it("resolves relative paths against the base", () => {
    expect(resolvePreviewPaths("C:\\proj", "src/a.md")).toEqual({
      rel: "src/a.md",
      abs: "C:/proj/src/a.md"
    });
  });

  it("relativizes absolute paths inside the base", () => {
    expect(resolvePreviewPaths("C:\\proj", "C:\\proj\\src\\a.md")).toEqual({
      rel: "src/a.md",
      abs: "C:/proj/src/a.md"
    });
  });

  it("passes outside paths through", () => {
    expect(resolvePreviewPaths("C:\\proj", "D:\\x\\a.md")).toEqual({
      rel: "D:/x/a.md",
      abs: "D:/x/a.md"
    });
  });
});

describe("buildPreviewHtml", () => {  it("wraps rendered markdown in a standalone document", () => {
    const html = buildPreviewHtml("a.md", "# Hi\n\nSome *text*.");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>a.md</title>");
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain("<style>");
  });

  it("escapes the title", () => {
    expect(buildPreviewHtml("<b>x</b>", "hi")).toContain("<title>&lt;b&gt;x&lt;/b&gt;</title>");
  });
});

describe("isPathInsideBase / isAbsolutePath", () => {
  it("detects paths inside the base", () => {
    expect(isPathInsideBase("C:\\proj", "C:/proj/src/a.md")).toBe(true);
    expect(isPathInsideBase("C:/proj/", "C:\\PROJ")).toBe(true);
    expect(isPathInsideBase("C:\\proj", "C:\\other\\a.md")).toBe(false);
    expect(isPathInsideBase("C:\\proj", "C:\\proj2\\a.md")).toBe(false);
    expect(isPathInsideBase("", "C:\\x\\a.md")).toBe(false);
  });

  it("detects absolute paths", () => {
    expect(isAbsolutePath("C:\\x\\a.md")).toBe(true);
    expect(isAbsolutePath("C:/x/a.md")).toBe(true);
    expect(isAbsolutePath("/x/a.md")).toBe(true);
    expect(isAbsolutePath("rel/a.md")).toBe(false);
  });
});

describe("sanitizeStreamingMarkdown", () => {
  it("returns closed fence unchanged", () => {
    const text = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(sanitizeStreamingMarkdown(text)).toBe(text);
  });

  it("closes unclosed fence", () => {
    expect(sanitizeStreamingMarkdown("before\n```ts\nconst x = 1;")).toBe("before\n```ts\nconst x = 1;\n```");
  });

  it("returns text without fence unchanged", () => {
    const text = "just **some** text";
    expect(sanitizeStreamingMarkdown(text)).toBe(text);
  });

  it("leaves unclosed inline code alone", () => {
    const text = "use `inline code here";
    expect(sanitizeStreamingMarkdown(text)).toBe(text);
  });
});
