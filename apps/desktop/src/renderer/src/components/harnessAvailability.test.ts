import { describe, expect, it } from "vitest";
import type { DriverName } from "../cw.js";
import { fallbackHarness, installedHarnesses, isHarnessSkipped, pickableHarnesses } from "./harnessAvailability.js";

function check(binary: DriverName, available: boolean, configured = false) {
  return { binary, available, configured };
}

describe("isHarnessSkipped", () => {
  it("skips only a missing harness left on its default path", () => {
    expect(isHarnessSkipped(check("codex", false))).toBe(true);
    expect(isHarnessSkipped(check("codex", false, true))).toBe(false);
    expect(isHarnessSkipped(check("codex", true))).toBe(false);
  });
});

describe("installedHarnesses", () => {
  it("keeps canonical order and drops skipped harnesses", () => {
    expect(installedHarnesses([check("codex", false), check("claude", true), check("opencode", true)])).toEqual([
      "claude",
      "opencode"
    ]);
  });

  it("keeps a broken harness the user configured explicitly", () => {
    expect(installedHarnesses([check("claude", true), check("opencode", false), check("codex", false, true)])).toEqual([
      "claude",
      "codex"
    ]);
  });
});

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
