import { describe, expect, test } from "bun:test";
import type { HistoryCommitPull } from "@cw-code/contracts";
import { branchPulls } from "./branchPulls.js";

const pull = (number: number, headRefName: string, state: HistoryCommitPull["state"] = "OPEN"): HistoryCommitPull => ({
  ref: { host: "github.com", owner: "o", repo: "r", number },
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  isDraft: false,
  mergedAt: null,
  headRefName,
  baseRefName: "main"
});

describe("branchPulls", () => {
  test("keeps only pull requests whose head is the branch", () => {
    const pulls = [pull(3, "feature"), pull(2, "other"), pull(1, "feature", "CLOSED")];
    expect(branchPulls(pulls, "feature", null).map((entry) => entry.ref.number)).toEqual([3, 1]);
  });

  test("gives the tip of main no pull request when it arrived through feature PRs", () => {
    expect(branchPulls([pull(149, "fix/saml", "MERGED")], "master", "origin/master")).toEqual([]);
  });

  test("matches the tracked branch when the local name differs", () => {
    expect(branchPulls([pull(7, "feat/remote-name")], "local-name", "origin/feat/remote-name").map((entry) => entry.ref.number)).toEqual([7]);
  });

  test("ignores an empty upstream", () => {
    expect(branchPulls([pull(1, "")], "feature", "")).toEqual([]);
  });
});
