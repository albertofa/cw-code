import { describe, expect, it } from "bun:test";
import {
  addQualifier,
  kindFromQuery,
  normalizeQuery,
  qualifiersFor,
  queryProblems,
  sortKeysFor,
  stateOf,
  tokenize,
  withQualifier,
  withState,
} from "./githubQueryDsl.js";

describe("tokenize", () => {
  it("splits qualifiers, text and spaces with positions", () => {
    const tokens = tokenize("is:pr author:@me foo");
    expect(tokens.map((t) => [t.kind, t.start, t.end])).toEqual([
      ["qual", 0, 5],
      ["space", 5, 6],
      ["qual", 6, 16],
      ["space", 16, 17],
      ["text", 17, 20],
    ]);
    expect(tokens[2]).toMatchObject({ key: "author", rawKey: "author", value: "@me", neg: false });
  });

  it("keeps quoted values together and strips the quotes from value", () => {
    const [token] = tokenize('label:"good first issue"');
    expect(token).toMatchObject({ kind: "qual", key: "label", value: "good first issue", rawValue: '"good first issue"' });
  });

  it("handles an unterminated quote", () => {
    const [token] = tokenize('label:"good fi');
    expect(token.value).toBe("good fi");
    expect(token.end).toBe(14);
  });

  it("marks negation and lower-cases the key", () => {
    const [token] = tokenize("-Repo:acme/x");
    expect(token).toMatchObject({ neg: true, key: "repo", rawKey: "Repo", value: "acme/x" });
  });

  it("treats a bare word as text", () => {
    expect(tokenize("-foo")[0]).toMatchObject({ kind: "text", value: "-foo" });
  });
});

describe("queryProblems", () => {
  it("flags unknown qualifiers", () => {
    expect(queryProblems("pr", "foo:bar")).toEqual(["Unknown qualifier foo:"]);
  });

  it("uses GitHub's syntax for close reasons and drops no:reviewers", () => {
    expect(queryProblems("issue", 'reason:"not planned" reason:completed')).toEqual([]);
    expect(queryProblems("issue", "reason:not_planned")).toEqual(["not_planned isn't a valid value for reason:"]);
    expect(queryProblems("pr", "no:reviewers")).toEqual(["reviewers isn't a valid value for no:"]);
  });

  it("flags bad enum values", () => {
    expect(queryProblems("run", "status:broken")).toEqual(["broken isn't a valid value for status:"]);
  });

  it("accepts valid and local keys and ignores empty values", () => {
    expect(queryProblems("pr", "is:pr has:session cloned:true is:unread status:")).toEqual([]);
  });

  it("validates per kind", () => {
    expect(queryProblems("run", "cloned:true")).toEqual(["Unknown qualifier cloned:"]);
    expect(queryProblems("run", "sort:updated-desc")).toEqual(["updated-desc isn't a valid value for sort:"]);
  });

  it("accepts local qualifiers with any casing", () => {
    expect(queryProblems("pr", "is:Unread has:Session")).toEqual([]);
  });

  it("reports unknown keys as typed", () => {
    expect(queryProblems("issue", "foo:bar")).toEqual(["Unknown qualifier foo:"]);
  });

  it("validates GitHub's standard search qualifiers", () => {
    expect(
      queryProblems("pr", "created:>2026-01-01 updated:<2026-02-01 closed:2026-03-01 comments:>5 commenter:lcosta in:title user:acme language:go head:feat/x base:main merged:>2026-01-01 team-review-requested:acme/core is:locked"),
    ).toEqual([]);
    expect(queryProblems("issue", "created:>2026-01-01 in:body is:locked language:go")).toEqual([]);
    expect(queryProblems("issue", "head:feat/x")).toEqual(["Unknown qualifier head:"]);
    expect(queryProblems("pr", "in:author")).toEqual(["author isn't a valid value for in:"]);
  });
});

describe("kindFromQuery", () => {
  it("returns the last non-negated kind", () => {
    expect(kindFromQuery("is:pr is:issue")).toBe("issue");
    expect(kindFromQuery("is:run -is:issue")).toBe("run");
    expect(kindFromQuery("author:@me")).toBeNull();
  });

  it("reads the kind case-insensitively", () => {
    expect(kindFromQuery("is:Issue")).toBe("issue");
  });
});

describe("sort keys", () => {
  it("offers created sorts for runs and the full set for the other kinds", () => {
    expect(sortKeysFor("run")).toEqual(["created-desc", "created-asc"]);
    expect(sortKeysFor("pr")).toContain("comments-desc");
    expect(qualifiersFor("run").find((def) => def.key === "sort")?.enumValues?.map((o) => o.value)).toEqual(sortKeysFor("run"));
  });
});

describe("query rewrites", () => {
  it("reads and toggles state", () => {
    expect(stateOf("is:pr is:merged")).toBe("closed");
    expect(stateOf("is:pr state:open")).toBe("open");
    expect(stateOf("is:pr -is:open")).toBeNull();
    expect(withState("is:pr is:open author:@me", "closed")).toBe("is:pr author:@me state:closed");
  });

  it("reads state values case-insensitively", () => {
    expect(stateOf("is:Merged")).toBe("closed");
    expect(withState("is:Open is:pr", "closed")).toBe("is:pr state:closed");
  });

  it("replaces a qualifier or removes it", () => {
    expect(withQualifier("is:pr sort:created-asc foo", "sort", "updated-desc")).toBe("is:pr foo sort:updated-desc");
    expect(withQualifier("is:pr sort:created-asc", "sort", null)).toBe("is:pr");
  });

  it("appends a qualifier once and quotes values with spaces", () => {
    expect(addQualifier("is:pr", "label", "good first issue")).toBe('is:pr label:"good first issue"');
    expect(addQualifier("is:pr label:bug", "label", "bug")).toBe("is:pr label:bug");
    expect(addQualifier("", "repo", "acme/x")).toBe("repo:acme/x");
  });

  it("normalizes whitespace", () => {
    expect(normalizeQuery("  is:pr   author:@me \n foo ")).toBe("is:pr author:@me foo");
  });
});
