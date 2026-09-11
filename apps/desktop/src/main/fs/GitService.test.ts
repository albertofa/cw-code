import { describe, expect, it } from "vitest";
import { isAppManagedPath, parsePrNumber, worktreeNameFor } from "./GitService.js";

describe("parsePrNumber", () => {
  it("parses a PR number", () => {
    expect(parsePrNumber("21\n")).toBe(21);
  });

  it("returns null for empty or invalid output", () => {
    expect(parsePrNumber("")).toBeNull();
    expect(parsePrNumber("nope")).toBeNull();
  });
});

describe("worktreeNameFor", () => {
  it("takes the last path segment", () => {
    expect(worktreeNameFor("C:\\Projects\\cw-code")).toBe("cw-code");
    expect(worktreeNameFor("/repo/my-worktree/")).toBe("my-worktree");
  });
});

describe("isAppManagedPath", () => {
  it("matches the .cw app-managed directory in posix and windows forms", () => {
    expect(isAppManagedPath(".cw")).toBe(true);
    expect(isAppManagedPath(".cw/pastes/x.png")).toBe(true);
    expect(isAppManagedPath(".cw\\pastes\\x.png")).toBe(true);
    expect(isAppManagedPath("src/.cw/x.png")).toBe(false);
    expect(isAppManagedPath(".cwutils/x.png")).toBe(false);
    expect(isAppManagedPath("src/main.ts")).toBe(false);
  });
});
