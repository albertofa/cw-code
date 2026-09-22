// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
