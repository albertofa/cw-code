import { describe, expect, it } from "vitest";
import { assertSearchQuery, withTypeQualifier } from "./GitHubSearchService.js";

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

  it("does not mistake a longer value for the qualifier", () => {
    expect(withTypeQualifier("pr", "is:pro")).toBe("is:pro is:pr");
  });
});
