import { describe, expect, it } from "vitest";
import { buildClaudeArgs, mapClaudeEffort, mapClaudePermission } from "./ClaudeCliDriver.js";

describe("mapClaudePermission", () => {
  it("passes through supported modes", () => {
    expect(mapClaudePermission("auto")).toBe("auto");
    expect(mapClaudePermission("acceptEdits")).toBe("acceptEdits");
    expect(mapClaudePermission("bypassPermissions")).toBe("bypassPermissions");
    expect(mapClaudePermission("manual")).toBe("manual");
    expect(mapClaudePermission("plan")).toBe("plan");
  });

  it("falls back to auto for unknown values", () => {
    expect(mapClaudePermission("default")).toBe("auto");
    expect(mapClaudePermission("")).toBe("auto");
  });
});

describe("mapClaudeEffort", () => {
  it("passes through supported levels", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(mapClaudeEffort(level)).toBe(level);
    }
  });

  it("falls back to medium for unknown values", () => {
    expect(mapClaudeEffort("ultra")).toBe("medium");
  });
});

describe("buildClaudeArgs", () => {
  it("includes model, effort, and permission flags", () => {
    const args = buildClaudeArgs({
      prompt: "hello",
      model: "claude-fable-5",
      effort: "high",
      permissionMode: "auto"
    });
    expect(args).toContain("--model");
    expect(args).toContain("claude-fable-5");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
  });

  it("omits unset optionals", () => {
    const args = buildClaudeArgs({ prompt: "hello" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--permission-mode");
  });
});
