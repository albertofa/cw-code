// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../stores/appStore.js";
import { AgentsPanel } from "./AgentsPanel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};

function fatalErrors(errors: string[]): string[] {
  return errors.filter((e) => /getSnapshot|Maximum update depth|185/.test(e));
}

describe("AgentsPanel", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let origError!: (...args: unknown[]) => void;
  let errors: string[] = [];
  let pristine: Record<string, unknown> | null = null;

  afterEach(async () => {
    console.error = origError;
    await act(async () => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });

  async function mount(sessionId: string): Promise<{ rerender: (id: string) => Promise<void> }> {
    const { useAppStore } = await import("../stores/appStore.js");
    if (!pristine) pristine = { ...useAppStore.getState() };
    else useAppStore.setState({ ...pristine });
    const message: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "hello",
      turnId: "turn-1"
    };
    useAppStore.setState({ messagesBySession: { sess_cached: [message] } });
    errors = [];
    origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<AgentsPanel sessionId={sessionId} />);
    });
    return {
      rerender: async (id: string) => {
        await act(async () => {
          root!.render(<AgentsPanel sessionId={id} />);
        });
      }
    };
  }

  it("renders a session with no loaded messages without looping", async () => {
    await mount("sess_empty");
    expect(host!.innerHTML).toContain("No subagents");
    expect(fatalErrors(errors)).toEqual([]);
  });

  it("switches from a cached session to an uncached one without looping", async () => {
    const panel = await mount("sess_cached");
    await panel.rerender("sess_other");
    expect(fatalErrors(errors)).toEqual([]);
  });
});
