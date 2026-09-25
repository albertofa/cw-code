// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "./RootErrorBoundary.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Bomb(): never {
  throw new Error("boom during render");
}

describe("RootErrorBoundary", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let origError!: (...args: unknown[]) => void;

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

  it("renders a reload fallback instead of unmounting the app", async () => {
    origError = console.error;
    console.error = () => {};
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <RootErrorBoundary>
          <Bomb />
        </RootErrorBoundary>
      );
    });
    expect(host.innerHTML).toContain("Something went wrong");
    expect(host.innerHTML).toContain("Reload app");
    expect(host.innerHTML).toContain("boom during render");
  });
});
