import { describe, expect, it } from "vitest";
import { assertCountBase, assertSearchQuery, GitHubSearchService, withTypeQualifier } from "./GitHubSearchService.js";

describe("assertCountBase", () => {
  it("accepts an empty or blank string and one up to 512 characters", () => {
    expect(() => assertCountBase("")).not.toThrow();
    expect(() => assertCountBase("   ")).not.toThrow();
    expect(() => assertCountBase("a".repeat(512))).not.toThrow();
  });

  it("rejects non-strings and strings over 512 characters", () => {
    expect(() => assertCountBase(undefined)).toThrow();
    expect(() => assertCountBase(null)).toThrow();
    expect(() => assertCountBase(5)).toThrow();
    expect(() => assertCountBase("a".repeat(513))).toThrow();
  });
});

describe("GitHubSearchService input validation", () => {
  const service = new GitHubSearchService(() => {
    throw new Error("settings must not be read for invalid input");
  });

  it("rejects an unknown kind, a non-string count base and an oversized count base", async () => {
    await expect((service.search as (...args: unknown[]) => Promise<unknown>)("run", "is:open", "")).rejects.toThrow("invalid search kind");
    await expect((service.search as (...args: unknown[]) => Promise<unknown>)("pr", "is:open", undefined)).rejects.toThrow("count base");
    await expect(service.search("pr", "is:open", "a".repeat(513))).rejects.toThrow("count base");
    await expect((service.counts as (...args: unknown[]) => Promise<unknown>)("run", ["is:open"])).rejects.toThrow("invalid search kind");
  });
});

describe("assertSearchQuery", () => {
  it("accepts a non-empty query up to 512 characters", () => {
    expect(() => assertSearchQuery("is:open author:@me")).not.toThrow();
    expect(() => assertSearchQuery("a".repeat(512))).not.toThrow();
  });

  it("rejects non-strings, blank queries and queries over 512 characters", () => {
    expect(() => assertSearchQuery(42)).toThrow();
    expect(() => assertSearchQuery(undefined)).toThrow();
    expect(() => assertSearchQuery("   ")).toThrow();
    expect(() => assertSearchQuery("a".repeat(513))).toThrow();
  });

  it("measures the trimmed length", () => {
    expect(() => assertSearchQuery(`  ${"a".repeat(512)}  `)).not.toThrow();
  });
});

describe("withTypeQualifier", () => {
  it("appends the type qualifier when missing", () => {
    expect(withTypeQualifier("pr", "author:@me")).toBe("author:@me is:pr");
    expect(withTypeQualifier("issue", "label:bug")).toBe("label:bug is:issue");
    expect(withTypeQualifier("pr", "")).toBe("is:pr");
  });

  it("keeps a query that already has the qualifier, in either spelling", () => {
    expect(withTypeQualifier("pr", "is:pr is:open")).toBe("is:pr is:open");
    expect(withTypeQualifier("issue", "is:open type:issue")).toBe("is:open type:issue");
    expect(withTypeQualifier("pr", "IS:PR author:@me")).toBe("IS:PR author:@me");
  });

  it("does not count a negated qualifier, so the type qualifier is still appended", () => {
    expect(withTypeQualifier("pr", "-is:pr author:@me")).toBe("-is:pr author:@me is:pr");
  });

  it("does not mistake a longer value for the qualifier", () => {
    expect(withTypeQualifier("pr", "is:pro")).toBe("is:pro is:pr");
  });
});
