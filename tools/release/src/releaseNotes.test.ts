import { describe, expect, it } from "vitest";
import { buildReleaseNotes, groupCommitSubjects, renderReleaseNotes } from "./releaseNotes.ts";

describe("groupCommitSubjects", () => {
  it("groups feat/fix/perf commits by type", () => {
    const groups = groupCommitSubjects([
      "feat(sessions): auto-generated session titles",
      "fix(pr): key the dock's already-sent guard on the updates",
      "perf(git): poll only working set sessions"
    ]);
    expect(groups.feat).toEqual(["feat(sessions): auto-generated session titles"]);
    expect(groups.fix).toEqual(["fix(pr): key the dock's already-sent guard on the updates"]);
    expect(groups.perf).toEqual(["perf(git): poll only working set sessions"]);
  });

  it("skips chore(release) commits", () => {
    const groups = groupCommitSubjects(["chore(release): v0.0.1-alpha.21", "feat: something"]);
    expect(groups.other).not.toContain("chore(release): v0.0.1-alpha.21");
    expect(groups.feat).toEqual(["feat: something"]);
  });

  it("skips docs-only commits", () => {
    const groups = groupCommitSubjects(["docs: update readme"]);
    expect(groups.feat).toEqual([]);
    expect(groups.fix).toEqual([]);
    expect(groups.perf).toEqual([]);
    expect(groups.other).toEqual([]);
  });

  it("buckets everything else, including merge commit subjects, as other", () => {
    const groups = groupCommitSubjects([
      "Merge pull request #23 from albertofa/release/v0.0.1-alpha.21",
      "refactor: tidy up session store",
      "chore(deps): bump vitest"
    ]);
    expect(groups.other).toEqual([
      "Merge pull request #23 from albertofa/release/v0.0.1-alpha.21",
      "refactor: tidy up session store",
      "chore(deps): bump vitest"
    ]);
  });
});

describe("renderReleaseNotes", () => {
  it("renders sections in a deterministic order and skips empty ones", () => {
    const notes = renderReleaseNotes({ feat: ["feat: a"], fix: [], perf: ["perf: b"], other: [] });
    expect(notes).toBe("## Features\n\n- feat: a\n\n## Performance\n\n- perf: b");
  });

  it("renders a placeholder when there is nothing to report", () => {
    expect(renderReleaseNotes({ feat: [], fix: [], perf: [], other: [] })).toBe("_No changes._");
  });
});

describe("buildReleaseNotes", () => {
  it("is deterministic for the same input", () => {
    const subjects = ["feat: a", "fix: b", "chore(release): v1"];
    expect(buildReleaseNotes(subjects)).toBe(buildReleaseNotes(subjects));
  });
});
