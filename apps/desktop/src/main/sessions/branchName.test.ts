import { describe, expect, it } from "bun:test";
import { branchNameForTitle, shouldRenameSessionBranch, slugForBranchTitle, TEMP_BRANCH_PATTERN } from "./branchName.js";

describe("branchName", () => {
  it("slugs titles to lowercase hyphenated branch names", () => {
    expect(branchNameForTitle("Fix Login Bug")).toBe("cw/fix-login-bug");
    expect(branchNameForTitle("Fix: login/bug?? v2")).toBe("cw/fix-login-bug-v2");
  });

  it("truncates long titles to 40 characters without a trailing dash", () => {
    const slug = slugForBranchTitle("This is a very long session title that goes on and on forever");
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(40);
    expect(slug!.endsWith("-")).toBe(false);
    expect(branchNameForTitle("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(`cw/${"a".repeat(40)}`);
    expect(branchNameForTitle("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa- trailing")).toBe(`cw/${"a".repeat(40)}`);
  });

  it("returns null for punctuation-only or whitespace titles", () => {
    expect(branchNameForTitle("???")).toBeNull();
    expect(branchNameForTitle("   ")).toBeNull();
    expect(branchNameForTitle("---")).toBeNull();
  });

  it("matches only temporary cw branch names with an optional numeric suffix", () => {
    expect(TEMP_BRANCH_PATTERN.test("cw/1234abcd")).toBe(true);
    expect(TEMP_BRANCH_PATTERN.test("cw/1234abcd-1")).toBe(true);
    expect(TEMP_BRANCH_PATTERN.test("cw/fix-login-bug")).toBe(false);
    expect(TEMP_BRANCH_PATTERN.test("main")).toBe(false);
    expect(TEMP_BRANCH_PATTERN.test("cw/1234abcd-100")).toBe(true);
    expect(TEMP_BRANCH_PATTERN.test("cw/1234ab")).toBe(false);
  });
});

describe("shouldRenameSessionBranch", () => {
  const safe = { temporary: true, hasLinks: false, published: false, shared: false };

  it("renames only an unpublished, unlinked, unshared temporary branch", () => {
    expect(shouldRenameSessionBranch(safe)).toBe(true);
  });

  it("keeps the branch when any guard trips", () => {
    expect(shouldRenameSessionBranch({ ...safe, temporary: false })).toBe(false);
    expect(shouldRenameSessionBranch({ ...safe, hasLinks: true })).toBe(false);
    expect(shouldRenameSessionBranch({ ...safe, published: true })).toBe(false);
    expect(shouldRenameSessionBranch({ ...safe, shared: true })).toBe(false);
  });
});
