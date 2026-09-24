import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrRef, PrSummary } from "@cw-code/contracts";
import { assertPrRef, assertRunId, cloneTargetPath, mergeInboxItems } from "./PullRequestService.js";

function ref(overrides: Partial<PrRef> = {}): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number: 1, ...overrides };
}

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 },
    url: "https://github.com/acme/widgets/pull/1",
    title: "Base PR",
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "UNKNOWN",
    labels: [],
    updatedAt: 0,
    ...overrides
  };
}

describe("mergeInboxItems", () => {
  it("keeps the first list's order and drops later duplicates by prKey", () => {
    const open = [summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 } })];
    const merged = [
      summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 }, title: "duplicate" }),
      summary({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 2 } })
    ];
    const result = mergeInboxItems([open, merged]);
    expect(result.map((item) => item.ref.number)).toEqual([1, 2]);
    expect(result[0].title).toBe("Base PR");
  });

  it("returns an empty list when every input list is empty", () => {
    expect(mergeInboxItems([[], []])).toEqual([]);
  });
});

describe("cloneTargetPath", () => {
  it("expands ~ against the given home directory and appends owner/repo", () => {
    const target = cloneTargetPath("~/.cw-code/repos", { owner: "acme", repo: "widgets" }, "C:\\Users\\tester");
    expect(target).toBe(join("C:\\Users\\tester", ".cw-code", "repos", "acme", "widgets"));
  });

  it("leaves an absolute clone root untouched", () => {
    const target = cloneTargetPath("C:\\repos", { owner: "acme", repo: "widgets" }, "C:\\Users\\tester");
    expect(target).toBe(join("C:\\repos", "acme", "widgets"));
  });

  it("rejects a relative clone root", () => {
    expect(() => cloneTargetPath("repos", { owner: "acme", repo: "widgets" }, "C:\\Users\\tester")).toThrow();
  });

  it("rejects a clone root starting with a dash", () => {
    expect(() => cloneTargetPath("-rf", { owner: "acme", repo: "widgets" }, "C:\\Users\\tester")).toThrow();
  });

  it("rejects a repo segment that would escape the clone root", () => {
    expect(() => cloneTargetPath("C:\\repos", { owner: "acme", repo: ".." }, "C:\\Users\\tester")).toThrow();
  });
});

describe("assertPrRef", () => {
  it("accepts a valid ref", () => {
    expect(() => assertPrRef(ref())).not.toThrow();
  });

  it("rejects a number smuggled in as a string starting with @", () => {
    expect(() => assertPrRef(ref({ number: "@file" as unknown as number }))).toThrow();
  });

  it("rejects a negative number", () => {
    expect(() => assertPrRef(ref({ number: -1 }))).toThrow();
  });

  it("rejects a float number", () => {
    expect(() => assertPrRef(ref({ number: 1.5 }))).toThrow();
  });

  it("rejects a repo of '..'", () => {
    expect(() => assertPrRef(ref({ repo: ".." }))).toThrow();
  });

  it("rejects an owner containing a slash", () => {
    expect(() => assertPrRef(ref({ owner: "acme/evil" }))).toThrow();
  });

  it("rejects a host other than github.com", () => {
    expect(() => assertPrRef(ref({ host: "github.example.com" }))).toThrow();
  });
});

describe("assertRunId", () => {
  it("accepts a positive safe integer", () => {
    expect(() => assertRunId(123)).not.toThrow();
  });

  it("rejects a flag-shaped string", () => {
    expect(() => assertRunId("--web" as unknown as number)).toThrow();
  });

  it("rejects zero and negative values", () => {
    expect(() => assertRunId(0)).toThrow();
    expect(() => assertRunId(-5)).toThrow();
  });
});
