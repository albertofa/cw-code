// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCard } from "./ToolCard.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function toolMsg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "tool", text: "", turnId: "t1", ...partial };
}

describe("ToolCard path display", () => {
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

  async function renderCard(message: ChatMessage, basePath?: string): Promise<string> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ToolCard message={message} basePath={basePath} />);
    });
    return host.innerHTML;
  }

  it("strips the @ marker from transcript-style Read mentions", async () => {
    const html = await renderCard(
      toolMsg({ id: "m1", toolName: "Read", text: "Read @.cw/pastes/cw-paste-x.png" }),
      "C:\\proj"
    );
    expect(html).toContain('<span class="tool-subject" title="@.cw/pastes/cw-paste-x.png">.cw/pastes/cw-paste-x.png</span>');
  });

  it("falls back to ~/ for transcript-style absolute paths under home", async () => {
    useAppStore.setState({ homeDir: "C:\\Users\\tester" });
    const html = await renderCard(
      toolMsg({ id: "m2", toolName: "Read", text: "Read C:\\Users\\tester\\docs\\a.md" }),
      "C:\\proj"
    );
    expect(html).toContain("~/docs/a.md");
  });

  it("shortens structured file inputs outside the project base", async () => {
    useAppStore.setState({ homeDir: "C:\\Users\\tester" });
    const html = await renderCard(
      toolMsg({ id: "m3", toolName: "Read", toolInput: { file_path: "C:\\Users\\tester\\docs\\a.md" } }),
      "C:\\proj"
    );
    expect(html).toContain("~/docs/a.md");
  });
});
