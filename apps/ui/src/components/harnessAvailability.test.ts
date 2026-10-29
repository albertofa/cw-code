import { describe, expect, it } from "bun:test";
import { fallbackHarness, pickableHarnesses } from "./harnessAvailability.js";

describe("pickableHarnesses", () => {
  it("offers every harness until availability is known or when none is installed", () => {
    expect(pickableHarnesses(null)).toEqual(["claude", "opencode", "codex"]);
    expect(pickableHarnesses([])).toEqual(["claude", "opencode", "codex"]);
    expect(pickableHarnesses(["opencode"])).toEqual(["opencode"]);
  });
});

describe("fallbackHarness", () => {
  it("moves off a harness that is not installed", () => {
    expect(fallbackHarness("codex", ["claude", "opencode"])).toBe("claude");
    expect(fallbackHarness("opencode", ["claude", "opencode"])).toBe("opencode");
    expect(fallbackHarness("codex", null)).toBe("codex");
    expect(fallbackHarness("codex", [])).toBe("codex");
  });
});
