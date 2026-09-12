import { describe, expect, it } from "vitest";
import { toolResultFromState } from "./opencodeEvents.js";

describe("toolResultFromState", () => {
  it("maps string state to a plain result", () => {
    expect(toolResultFromState("contents")).toEqual({ output: "contents", isError: false });
  });

  it("maps completed tool state to call output", () => {
    expect(
      toolResultFromState({ status: "completed", input: { path: "a.ts" }, output: "contents" })
    ).toEqual({ output: "contents", isError: false });
  });

  it("marks error tool state as failed result", () => {
    expect(
      toolResultFromState({ status: "error", input: { command: "ls" }, output: "nope", error: "boom" })
    ).toEqual({ output: "nope", isError: true });
  });

  it("surfaces error payloads when output is empty", () => {
    expect(toolResultFromState({ status: "error", error: "boom" })).toEqual({
      output: "boom",
      isError: true
    });
  });

  it("returns null for running or malformed states", () => {
    expect(toolResultFromState({ status: "running", output: "partial" })).toBeNull();
    expect(toolResultFromState(null)).toBeNull();
    expect(toolResultFromState(42)).toBeNull();
  });
});
