import "../../../../tests/dom.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "bun:test";
import { ToolCard } from "./ToolCard.js";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { installFakeTopics, type FakeTopics } from "../../../../tests/fakeTopics.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installFakeTopics();

function toolMsg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "tool", text: "", turnId: "t1", seq: 0, ...partial };
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

describe("ToolCard row", () => {
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

  async function render(message: ChatMessage, sessionId?: string): Promise<HTMLDivElement> {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ToolCard message={message} sessionId={sessionId} />);
    });
    return host;
  }

  const rowOf = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>("button.tool-row")!;
  const statusOf = (el: HTMLElement): string | null => el.querySelector(".tool-state")!.getAttribute("aria-label");

  it("starts collapsed and reveals the controlled details on click", async () => {
    const el = await render(
      toolMsg({ id: "b1", toolName: "Bash", toolInput: { command: "pnpm test" }, toolOutput: "all green", toolDone: true })
    );
    const row = rowOf(el);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(el.textContent).not.toContain("all green");
    expect(statusOf(el)).toBe("Done");

    await act(async () => {
      row.click();
    });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = document.getElementById(row.getAttribute("aria-controls")!);
    expect(detail?.textContent).toContain("$pnpm test");
    expect(detail?.textContent).toContain("all green");
  });

  it("keeps the full command in the subject title and badges compound calls", async () => {
    const command = `git grep -n "x" -- .; git checkout -q --detach origin/master && dotnet test`;
    const el = await render(
      toolMsg({ id: "b5", toolName: "Bash", toolInput: { command, description: "run it" } })
    );
    const subject = el.querySelector(".tool-subject");
    expect(subject?.getAttribute("title")).toBe(command);
    expect(el.textContent).toContain("3 commands");
    expect(el.textContent).not.toContain("run it");
  });

  it("labels failed tools and their error output", async () => {
    const el = await render(
      toolMsg({ id: "b2", toolName: "Bash", toolInput: { command: "false" }, toolOutput: "boom", toolDone: true, isError: true })
    );
    expect(statusOf(el)).toBe("Failed");
    await act(async () => {
      rowOf(el).click();
    });
    expect(el.querySelector(".tool-detail")?.textContent).toContain("errorboom");
  });

  it("keeps a running tool as running when the pending approval names no tool", async () => {
    const running = toolMsg({ id: "b4", toolName: "Bash", toolInput: { command: "rm -rf build" } });
    installFakeTopics({ "session/s1": { approvals: [{ requestId: "r1", kind: "command", title: "bash", decisions: ["accept", "decline"] }] } });
    const el = await render(running, "s1");
    expect(statusOf(el)).toBe("Running");
  });

  it("marks a running tool as waiting while an approval for that tool is pending", async () => {
    const running = toolMsg({ id: "b3", toolName: "Bash", toolInput: { command: "rm -rf build" } });
    const topics: FakeTopics = installFakeTopics({
      "session/s1": { approvals: [{ requestId: "r1", kind: "command", title: "bash", toolName: "bash", decisions: ["accept", "decline"] }] }
    });
    const el = await render(running, "s1");
    expect(statusOf(el)).toBe("Waiting for approval");
    expect(el.textContent).toContain("needs approval");

    await act(async () => {
      topics.set("session/s1", { approvals: [] });
    });
    expect(statusOf(el)).toBe("Running");
  });
});
