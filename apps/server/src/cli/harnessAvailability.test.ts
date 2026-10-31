import { describe, expect, it } from "bun:test";
import type { CliVersionCheck, DriverKind } from "@cw-code/contracts";
import { harnessIssues, harnessUnavailableReason, installedHarnesses, isHarnessSkipped } from "./harnessAvailability.js";

function check(binary: DriverKind, found: boolean, configured = false) {
  return { binary, found, configured };
}

describe("isHarnessSkipped", () => {
  it("skips only a harness that was not found on its default path", () => {
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

describe("harnessIssues", () => {
  const version = (binary: DriverKind, overrides: Partial<CliVersionCheck> = {}): CliVersionCheck => ({
    binary,
    binaryPath: `/bin/${binary}`,
    minimum: "1.0.0",
    actual: "1.2.0",
    configured: false,
    found: true,
    available: true,
    error: null,
    ok: true,
    ...overrides
  });

  it("reports nothing when every harness is healthy", () => {
    expect(harnessIssues([version("claude"), version("opencode"), version("codex")])).toEqual([]);
  });

  it("reports no installed harness", () => {
    const skipped = (binary: DriverKind) => version(binary, { found: false, available: false, actual: null, ok: false });
    expect(harnessIssues([skipped("claude"), skipped("opencode"), skipped("codex")])).toEqual([
      {
        id: "cli-binaries",
        level: "error",
        title: "No harness installed",
        message: "Install Claude Code, OpenCode or Codex, or point cw-code at its executable in Settings.",
        binaries: []
      }
    ]);
  });

  it("reports a configured binary that cannot run", () => {
    const broken = version("codex", { configured: true, found: false, available: false, actual: null, ok: false, binaryPath: "/x/codex" });
    expect(harnessIssues([version("claude"), broken])).toEqual([
      {
        id: "cli-binaries",
        level: "error",
        title: "CLI binary unavailable",
        message: "codex: could not run '/x/codex'. Change its executable in Settings.",
        binaries: ["codex"]
      }
    ]);
  });

  it("reports an outdated version", () => {
    expect(harnessIssues([version("claude", { actual: "0.9.0", ok: false })])).toEqual([
      {
        id: "cli-versions",
        level: "warning",
        title: "CLI out of date",
        message: "claude: needs >= 1.0.0, found 0.9.0",
        binaries: ["claude"]
      }
    ]);
  });

  it("reports a failed version read ahead of outdated ones", () => {
    const issues = harnessIssues([version("claude", { actual: "0.9.0", ok: false }), version("opencode", { actual: null, ok: false })]);
    expect(issues).toEqual([
      {
        id: "cli-versions",
        level: "warning",
        title: "CLI version check failed",
        message: "opencode: could not read the version from '/bin/opencode'\nclaude: needs >= 1.0.0, found 0.9.0",
        binaries: ["opencode", "claude"]
      }
    ]);
  });
});

describe("harnessUnavailableReason", () => {
  const entry = (binary: DriverKind, overrides: Partial<CliVersionCheck> = {}) => {
    const base: CliVersionCheck = { binary, binaryPath: binary, minimum: "1.0.0", actual: "1.2.0", configured: false, found: true, available: true, error: null, ok: true, ...overrides };
    return { ...base, skipped: isHarnessSkipped(base) };
  };

  it("explains a harness that was not found on its default path", () => {
    const missing = entry("opencode", { found: false, available: false, actual: null, error: 'Executable not found in $PATH: "opencode.exe"' });
    expect(harnessUnavailableReason({ installed: ["claude"], checks: [entry("claude"), missing] }, "opencode")).toBe(
      `opencode: 'opencode' was not found (Executable not found in $PATH: "opencode.exe"). Install it or set its executable in Settings, then recheck the harnesses.`
    );
  });

  it("explains a configured binary that cannot run with the settings message", () => {
    const broken = entry("codex", { configured: true, available: false, actual: null, binaryPath: "/x/codex", error: "spawn EACCES" });
    expect(harnessUnavailableReason({ installed: ["claude", "codex"], checks: [broken] }, "codex")).toBe(
      "codex: could not run '/x/codex' (spawn EACCES). Change its executable in Settings."
    );
  });

  it("allows healthy, outdated and not yet checked harnesses", () => {
    const availability = { installed: ["claude", "codex"] as DriverKind[], checks: [entry("claude"), entry("codex", { actual: "0.1.0", ok: false })] };
    expect(harnessUnavailableReason(availability, "claude")).toBeNull();
    expect(harnessUnavailableReason(availability, "codex")).toBeNull();
    expect(harnessUnavailableReason({ installed: [], checks: [] }, "opencode")).toBeNull();
  });
});
