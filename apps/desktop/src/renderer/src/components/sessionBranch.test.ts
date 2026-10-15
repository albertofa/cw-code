import { describe, expect, it } from "vitest";
import {
  activeBranchMismatch,
  branchMismatch,
  keepLabel,
  mismatchSentence,
  sendHereLabel,
  shouldResetKeptBranch
} from "./sessionBranch.js";

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

describe("shouldResetKeptBranch", () => {
  it("does nothing when no branch was kept", () => {
    expect(shouldResetKeptBranch(undefined, onMain)).toBe(false);
  });

  it("keeps the choice while the folder stays on the kept branch", () => {
    expect(shouldResetKeptBranch("main", onMain)).toBe(false);
  });

  it("resets once the folder is on a different branch", () => {
    expect(shouldResetKeptBranch("main", { available: true, branch: "cw/b" })).toBe(true);
  });

  it("does not reset while the status is missing or unavailable", () => {
    expect(shouldResetKeptBranch("main", undefined)).toBe(false);
    expect(shouldResetKeptBranch("main", { available: false, branch: "" })).toBe(false);
  });

  it("warns again when the folder leaves and returns to the kept branch", () => {
    const session = { branch: "cw/a" };
    expect(activeBranchMismatch(session, onMain, "main")).toBeNull();
    expect(shouldResetKeptBranch("main", { available: true, branch: "cw/b" })).toBe(true);
    expect(activeBranchMismatch(session, onMain, undefined)).not.toBeNull();
  });
});

describe("mismatch wording", () => {
  it("names the folder branch", () => {
    const mismatch = { sessionBranch: "cw/a", folderBranch: "main" };
    expect(mismatchSentence("widgets", mismatch)).toBe("widgets is on main, not this session's branch cw/a.");
    expect(keepLabel(mismatch)).toBe("Keep working on main");
    expect(sendHereLabel(mismatch)).toBe("Send on main");
  });

  it("describes a detached HEAD", () => {
    const mismatch = { sessionBranch: "cw/a", folderBranch: "HEAD" };
    expect(mismatchSentence("widgets", mismatch)).toBe("widgets is in a detached HEAD state, not on this session's branch cw/a.");
    expect(keepLabel(mismatch)).toBe("Keep working here");
    expect(sendHereLabel(mismatch)).toBe("Send here");
  });
});
