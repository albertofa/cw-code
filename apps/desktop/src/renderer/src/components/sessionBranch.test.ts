import { describe, expect, it } from "vitest";
import { activeBranchMismatch, branchMismatch } from "./sessionBranch.js";

const onMain = { available: true, branch: "main" };

describe("branchMismatch", () => {
  it("reports the folder branch when it differs from the recorded session branch", () => {
    expect(branchMismatch({ branch: "cw/a" }, onMain)).toEqual({ sessionBranch: "cw/a", folderBranch: "main" });
  });

  it("is null when the folder is on the session branch", () => {
    expect(branchMismatch({ branch: "cw/a" }, { available: true, branch: "cw/a" })).toBeNull();
  });

  it("is null for worktree sessions", () => {
    expect(branchMismatch({ branch: "cw/a", worktreePath: "/wt/a" }, onMain)).toBeNull();
  });

  it("is null for sessions without a recorded branch", () => {
    expect(branchMismatch({}, onMain)).toBeNull();
    expect(branchMismatch({ branch: "" }, onMain)).toBeNull();
  });

  it("is null while the git status is missing or unavailable", () => {
    expect(branchMismatch({ branch: "cw/a" }, undefined)).toBeNull();
    expect(branchMismatch({ branch: "cw/a" }, null)).toBeNull();
    expect(branchMismatch({ branch: "cw/a" }, { available: false, branch: "" })).toBeNull();
  });

  it("is null without a session", () => {
    expect(branchMismatch(undefined, onMain)).toBeNull();
  });
});

describe("activeBranchMismatch", () => {
  it("returns the mismatch when nothing was kept", () => {
    expect(activeBranchMismatch({ branch: "cw/a" }, onMain, undefined)).toEqual({ sessionBranch: "cw/a", folderBranch: "main" });
  });

  it("is silenced while the folder stays on the kept branch", () => {
    expect(activeBranchMismatch({ branch: "cw/a" }, onMain, "main")).toBeNull();
  });

  it("returns again once the folder moves to another branch", () => {
    expect(activeBranchMismatch({ branch: "cw/a" }, { available: true, branch: "cw/b" }, "main")).toEqual({
      sessionBranch: "cw/a",
      folderBranch: "cw/b"
    });
  });
});
