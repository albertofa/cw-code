import "../../../../tests/dom.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Md } from "./Markdown.js";
import { useAppStore } from "../stores/appStore.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Md html file references", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
    useAppStore.setState({ homeDir: null });
  });

  async function renderMd(text: string, onOpenExternal = vi.fn()): Promise<string> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Md text={text} onOpenFile={() => {}} onOpenExternal={onOpenExternal} />);
    });
    return host.innerHTML;
  }

  it("turns an inline-code html path into a chip with an open button", async () => {
    const html = await renderMd("See `design/mockups/index.html` for the layout.");
    expect(html).toContain('class="md-link-html"');
    expect(html).toContain('class="md-link-html-browser"');
    expect(html).not.toContain("<code");
  });

  it("turns a local html markdown link into a chip", async () => {
    const html = await renderMd("[mockup](design/mockups/index.html)");
    expect(html).toContain('class="md-link-html"');
    expect(html).toContain('class="md-link-html-browser"');
  });

  it("leaves non-html inline code as code", async () => {
    const html = await renderMd("Edit `src/index.ts` next.");
    expect(html).toContain("<code");
    expect(html).not.toContain('class="md-link-html"');
  });

  it("leaves an html path inside a fenced code block as code", async () => {
    const html = await renderMd("```\ndesign/mockups/index.html\n```");
    expect(html).toContain("<code");
    expect(html).not.toContain('class="md-link-html"');
  });

  it("shortens a home-directory path to ~/", async () => {
    useAppStore.setState({ homeDir: "C:\\Users\\tester" });
    await renderMd("`C:\\Users\\tester\\AppData\\Local\\Temp\\agents-scratchpad\\plan.html`");
    const body = host!.querySelector(".md-link-html-body")!;
    expect(body.textContent).toBe("~/AppData/Local/Temp/agents-scratchpad/plan.html");
  });

  it("opens the resolved file externally when the button is clicked", async () => {
    const onOpenExternal = vi.fn();
    await renderMd("`design/index.html`", onOpenExternal);
    const button = host!.querySelector<HTMLButtonElement>(".md-link-html-browser")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenExternal).toHaveBeenCalledWith("design/index.html");
  });
});

describe("Md images", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
  });

  async function renderMd(text: string, allowImages?: boolean): Promise<HTMLDivElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Md text={text} allowImages={allowImages} />);
    });
    return host;
  }

  it("renders images by default", async () => {
    const rendered = await renderMd("![diagram](https://example.com/a.png)");
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("renders images as links labelled with their alt text when images are not allowed", async () => {
    const rendered = await renderMd("![diagram](https://example.com/a.png)", false);
    expect(rendered.querySelector("img")).toBeNull();
    const link = rendered.querySelector(".md-image-link a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a.png");
    expect(link?.textContent).toBe("diagram");
  });

  it("falls back to the image URL when there is no alt text", async () => {
    const rendered = await renderMd("![](https://example.com/b.png)", false);
    expect(rendered.querySelector(".md-image-link a")?.textContent).toBe("https://example.com/b.png");
  });

  it("renders an image inside a link as plain text to avoid nesting anchors", async () => {
    const rendered = await renderMd("[![diagram](https://example.com/a.png)](https://example.com/page)", false);
    expect(rendered.querySelector("a")?.querySelector("a")).toBeNull();
    expect(rendered.querySelector(".md-image-link")?.textContent).toBe("diagram");
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe("https://example.com/page");
  });
});

describe("Md raw html", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
  });

  async function renderMd(text: string, allowHtml: boolean): Promise<HTMLDivElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Md text={text} allowImages={false} allowHtml={allowHtml} />);
    });
    return host;
  }

  const footer = [
    "Body text",
    "",
    "<!-- codesmith:footer -->",
    '<a href="https://example.com/pr"><picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><img alt="View PR" src="https://example.com/light.svg"></picture></a> <sup>Need help? Tag <code>@bot</code>.</sup>'
  ].join("\n");

  it("escapes raw html by default", async () => {
    const rendered = await renderMd(footer, false);
    expect(rendered.textContent).toContain("<a href=");
    expect(rendered.querySelector("sup")).toBeNull();
  });

  it("renders sanitized html, hides comments and keeps images as text", async () => {
    const rendered = await renderMd(footer, true);
    expect(rendered.textContent).not.toContain("codesmith:footer");
    expect(rendered.textContent).not.toContain("<a href=");
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe("https://example.com/pr");
    expect(rendered.querySelector("a")?.textContent).toBe("View PR");
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.querySelector("source")).toBeNull();
    expect(rendered.querySelector("sup code")?.textContent).toBe("@bot");
  });

  it("strips scripts and event handlers", async () => {
    const rendered = await renderMd('<div onclick="alert(1)">hi</div><script>alert(2)</script><a href="javascript:alert(3)">x</a>', true);
    expect(rendered.querySelector("script")).toBeNull();
    expect(rendered.innerHTML).not.toContain("onclick");
    expect(rendered.innerHTML).not.toContain("javascript:");
  });
});
