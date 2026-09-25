import { describe, expect, it } from "vitest";
import { describeClaudeExit } from "./claudeExit.js";

describe("describeClaudeExit", () => {
  it("strips sandbox boilerplate and ANSI escapes down to the generic message", () => {
    expect(describeClaudeExit("\n\u001b[s\u001b[?25l Sandbox disabled: sandbox is enabled\n  Commands will run WITHOUT sandboxing.\n\n", 1)).toBe(
      "claude exited before completing the turn (code 1)"
    );
    expect(describeClaudeExit("", null)).toBe("claude exited before completing the turn (code null)");
  });

  it("preserves real error lines mixed with boilerplate", () => {
    expect(
      describeClaudeExit("Sandbox disabled\nError: socket hang up\n  Commands will run WITHOUT sandboxing.", 1)
    ).toBe("Error: socket hang up");
  });

  it("uses a caller-provided context for the generic fallback message", () => {
    expect(describeClaudeExit("", 1, "listing commands")).toBe("claude exited before listing commands (code 1)");
  });
});
