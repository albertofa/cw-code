import { describe, expect, it } from "vitest";
import { resolveDrop } from "./dockable.js";

describe("resolveDrop", () => {
  it("rejects the fixed Chat tab", () => {
    expect(resolveDrop("chat", "main")).toBeNull();
    expect(resolveDrop("chat", "right")).toBeNull();
    expect(resolveDrop("chat", "bottom")).toBeNull();
  });

  it("rejects unknown tab ids", () => {
    expect(resolveDrop("", "main")).toBeNull();
    expect(resolveDrop("bogus", "main")).toBeNull();
    expect(resolveDrop("Files", "main")).toBeNull();
  });

  it("routes tool tabs to the drop panel", () => {
    expect(resolveDrop("files", "main")).toEqual({ tab: "files", panel: "main" });
    expect(resolveDrop("shell", "bottom")).toEqual({ tab: "shell", panel: "bottom" });
    expect(resolveDrop("preview", "right")).toEqual({ tab: "preview", panel: "right" });
  });
});