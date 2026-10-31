import { describe, expect, it } from "bun:test";
import { expandLeadingPathVariable } from "./pathExpansion.js";

const env = { TEMP: "C:\\Users\\me\\Temp", TMPDIR: "/var/tmp", EMPTY: "", "ProgramFiles(x86)": "C:\\PF86" };
const win = { env, homeDir: "C:\\Users\\me", platform: "win32" as const };
const posix = { env, homeDir: "/home/me", platform: "linux" as const };

describe("expandLeadingPathVariable", () => {
  it.each([
    ["%TEMP%\\agents-scratchpad\\plan.md", "C:\\Users\\me\\Temp\\agents-scratchpad\\plan.md"],
    ["%temp%/plan.md", "C:\\Users\\me\\Temp/plan.md"],
    ["$env:TEMP\\plan.md", "C:\\Users\\me\\Temp\\plan.md"],
    ["$env:temp/plan.md", "C:\\Users\\me\\Temp/plan.md"],
    ["%ProgramFiles(x86)%\\app\\x.txt", "C:\\PF86\\app\\x.txt"],
    ["~\\notes.md", "C:\\Users\\me\\notes.md"],
    ["~", "C:\\Users\\me"]
  ])("expands %s on windows", (input, expected) => {
    expect(expandLeadingPathVariable(input, win)).toBe(expected);
  });

  it.each([
    ["$TMPDIR/agents-scratchpad/plan.md", "/var/tmp/agents-scratchpad/plan.md"],
    ["${TMPDIR}/plan.md", "/var/tmp/plan.md"],
    ["${TMPDIR:-/tmp}/plan.md", "/var/tmp/plan.md"],
    ["${UNSET:-/tmp}/agents-scratchpad/plan.md", "/tmp/agents-scratchpad/plan.md"],
    ["${EMPTY:-/tmp}/plan.md", "/tmp/plan.md"],
    ["~/plan.md", "/home/me/plan.md"]
  ])("expands %s on posix", (input, expected) => {
    expect(expandLeadingPathVariable(input, posix)).toBe(expected);
  });

  it("matches names case-sensitively off windows", () => {
    expect(expandLeadingPathVariable("$tmpdir/plan.md", posix)).toBe("$tmpdir/plan.md");
  });

  it.each([
    "%NOPE%\\plan.md",
    "$NOPE/plan.md",
    "$EMPTY/plan.md",
    "${UNSET}/plan.md",
    "src/plan.md",
    "C:\\repo\\plan.md",
    "/abs/plan.md",
    "~user/plan.md",
    "$TMPDIRX/plan.md",
    "%TEMP%plan.md",
    "src/%TEMP%/plan.md",
    "$(echo /etc)/passwd",
    "`echo /etc`/passwd"
  ])("leaves %s unchanged", (input) => {
    expect(expandLeadingPathVariable(input, posix)).toBe(input);
  });

  it("does not expand variables inside the expanded value", () => {
    expect(expandLeadingPathVariable("$A/x", { ...posix, env: { A: "$TMPDIR" } })).toBe("$TMPDIR/x");
  });
});
