import { describe, expect, it } from "vitest";
import { checkCountsTone, checksTone, gitDiffSummary, paneDiffSummary, railGroups } from "./railTools.js";

describe("railGroups", () => {
  it("groups review tools, terminals and preview", () => {
    expect(railGroups("claude", false, false)).toEqual([["overview", "diff", "files", "agents"], ["shell", "claude"]]);
  });

  it("adds the PR tool only when linked and preview only when present", () => {
    expect(railGroups("codex", true, true)).toEqual([["overview", "diff", "pr", "files", "agents"], ["shell", "codex"], ["preview"]]);
  });

  it("omits the harness CLI without a driver", () => {
    expect(railGroups(undefined, false, false)[1]).toEqual(["shell"]);
  });
});

describe("checksTone", () => {
  it("ranks failing over pending over passing", () => {
    expect(checksTone(["passing", "failing", "pending"])).toBe("danger");
    expect(checksTone(["passing", "pending"])).toBe("warning");
    expect(checksTone(["passing", "none"])).toBe("success");
  });

  it("has no tone without checks", () => {
    expect(checksTone([])).toBeNull();
    expect(checksTone(["none"])).toBeNull();
  });
});

describe("checkCountsTone", () => {
  it("maps git PR check counts", () => {
    expect(checkCountsTone(undefined)).toBeNull();
    expect(checkCountsTone({ total: 0, failed: 0, pending: 0 })).toBeNull();
    expect(checkCountsTone({ total: 3, failed: 1, pending: 1 })).toBe("danger");
    expect(checkCountsTone({ total: 3, failed: 0, pending: 1 })).toBe("warning");
    expect(checkCountsTone({ total: 3, failed: 0, pending: 0 })).toBe("success");
  });
});

describe("gitDiffSummary", () => {
  it("summarizes files and line counts", () => {
    expect(gitDiffSummary({ dirtyCount: 6, addedLines: 312, deletedLines: 48 })).toBe("6 files · +312 \u221248");
    expect(gitDiffSummary({ dirtyCount: 1, addedLines: 2, deletedLines: 0 })).toBe("1 file · +2 \u22120");
  });

  it("is empty for a clean tree or missing status", () => {
    expect(gitDiffSummary({ dirtyCount: 0, addedLines: 0, deletedLines: 0 })).toBeUndefined();
    expect(gitDiffSummary(undefined)).toBeUndefined();
  });
});

describe("paneDiffSummary", () => {
  const status = { dirtyCount: 6, addedLines: 312, deletedLines: 48 };

  it("uses the working tree when the diff panel is not in last-turn mode", () => {
    expect(paneDiffSummary(status, undefined)).toBe("6 files · +312 −48");
  });

  it("uses the turn totals in last-turn mode", () => {
    expect(paneDiffSummary(status, { files: 1, added: 4, deleted: 2 })).toBe("1 file · +4 −2");
  });

  it("stays empty while the turn diff loads or when the turn changed nothing", () => {
    expect(paneDiffSummary(status, null)).toBeUndefined();
    expect(paneDiffSummary(status, { files: 0, added: 0, deleted: 0 })).toBeUndefined();
  });
});
