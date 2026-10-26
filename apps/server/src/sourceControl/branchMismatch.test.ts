import { describe, expect, it } from "bun:test";
import {
  activeBranchMismatch,
  branchMismatch,
  currentCheckoutSessionIds,
  folderHeadValue,
  shouldResetKeptHead,
  validKeptHead
} from "./branchMismatch.js";

const onMain = { available: true, branch: "main" };

describe("branchMismatch", () => {
  it("reports the folder branch when it differs from the recorded session branch", () => {
    expect(branchMismatch({ branch: "cw/a" }, onMain)).toEqual({ sessionBranch: "cw/a", folderBranch: "main", folderHead: "main" });
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
    expect(activeBranchMismatch({ branch: "cw/a" }, onMain, undefined)).toEqual({ sessionBranch: "cw/a", folderBranch: "main", folderHead: "main" });
  });

  it("is silenced while the folder stays on the kept branch", () => {
    expect(activeBranchMismatch({ branch: "cw/a" }, onMain, "main")).toBeNull();
  });

  it("returns again once the folder moves to another branch", () => {
    expect(activeBranchMismatch({ branch: "cw/a" }, { available: true, branch: "cw/b" }, "main")).toEqual({
      sessionBranch: "cw/a",
      folderBranch: "cw/b",
      folderHead: "cw/b"
    });
  });
});

describe("shouldResetKeptHead", () => {
  it("does nothing when no branch was kept", () => {
    expect(shouldResetKeptHead(undefined, onMain)).toBe(false);
  });

  it("keeps the choice while the folder stays on the kept branch", () => {
    expect(shouldResetKeptHead("main", onMain)).toBe(false);
  });

  it("resets once the folder is on a different branch", () => {
    expect(shouldResetKeptHead("main", { available: true, branch: "cw/b" })).toBe(true);
  });

  it("does not reset while the status is missing or unavailable", () => {
    expect(shouldResetKeptHead("main", undefined)).toBe(false);
    expect(shouldResetKeptHead("main", { available: false, branch: "" })).toBe(false);
  });

  it("warns again when the folder leaves and returns to the kept branch", () => {
    const session = { branch: "cw/a" };
    expect(activeBranchMismatch(session, onMain, "main")).toBeNull();
    expect(shouldResetKeptHead("main", { available: true, branch: "cw/b" })).toBe(true);
    expect(activeBranchMismatch(session, onMain, undefined)).not.toBeNull();
  });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const detached = { available: true, branch: "HEAD", headSha: SHA };

describe("folderHeadValue", () => {
  it("uses the branch name", () => {
    expect(folderHeadValue(onMain)).toBe("main");
  });

  it("uses the commit sha when detached", () => {
    expect(folderHeadValue(detached)).toBe(SHA);
  });

  it("falls back to the literal HEAD when detached without a sha", () => {
    expect(folderHeadValue({ available: true, branch: "HEAD" })).toBe("HEAD");
    expect(folderHeadValue({ available: true, branch: "HEAD", headSha: null })).toBe("HEAD");
  });
});

describe("detached HEAD kept value", () => {
  const session = { branch: "cw/a" };

  it("records the sha, not the literal HEAD", () => {
    expect(branchMismatch(session, detached)?.folderHead).toBe(SHA);
  });

  it("is silenced only on the same commit", () => {
    expect(activeBranchMismatch(session, detached, SHA)).toBeNull();
    expect(activeBranchMismatch(session, { ...detached, headSha: "f".repeat(40) }, SHA)).not.toBeNull();
  });
});

describe("validKeptHead", () => {
  it("returns the kept value only while it equals the folder HEAD value", () => {
    expect(validKeptHead("main", onMain)).toBe("main");
    expect(validKeptHead("main", { available: true, branch: "cw/b" })).toBeUndefined();
    expect(validKeptHead(SHA, detached)).toBe(SHA);
    expect(validKeptHead(SHA, { ...detached, headSha: "f".repeat(40) })).toBeUndefined();
  });

  it("is undefined without a kept value or usable status", () => {
    expect(validKeptHead(undefined, onMain)).toBeUndefined();
    expect(validKeptHead("main", undefined)).toBeUndefined();
    expect(validKeptHead("main", { available: false, branch: "" })).toBeUndefined();
  });
});

describe("currentCheckoutSessionIds", () => {
  it("keeps only sessions without a worktree", () => {
    expect(
      currentCheckoutSessionIds([{ id: "a" }, { id: "b", worktreePath: "/wt/b" }, { id: "c", branch: "cw/c" }])
    ).toEqual(["a", "c"]);
  });
});
