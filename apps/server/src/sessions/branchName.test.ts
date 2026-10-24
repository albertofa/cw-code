import { describe, expect, it } from "bun:test";
import { branchNameForTitle, ownsSessionBranch, sanitizeGeneratedBranch, shouldRenameSessionBranch, slugForBranchTitle, TEMP_BRANCH_PATTERN } from "./branchName.js";

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

describe("sanitizeGeneratedBranch", () => {
  it("keeps valid names, including prefixes and case", () => {
    expect(sanitizeGeneratedBranch("feat/ABC-123-login-flow")).toBe("feat/ABC-123-login-flow");
    expect(sanitizeGeneratedBranch(" `fix/login` ")).toBe("fix/login");
  });

  it("removes characters and sequences git rejects", () => {
    expect(sanitizeGeneratedBranch("refs/heads/feat/login flow")).toBe("feat/login-flow");
    expect(sanitizeGeneratedBranch("feat//..hidden/x..y~^:?*[\\<>|]")).toBe("feat/hidden/x.y]");
    expect(sanitizeGeneratedBranch("-feat/name.lock")).toBe("feat/name");
    expect(sanitizeGeneratedBranch("feat/a@{1}")).toBe("feat/a1}");
    expect(sanitizeGeneratedBranch("feat/trailing/")).toBe("feat/trailing");
  });

  it("rejects names that are empty or reserved", () => {
    expect(sanitizeGeneratedBranch("")).toBeNull();
    expect(sanitizeGeneratedBranch("   ")).toBeNull();
    expect(sanitizeGeneratedBranch("HEAD")).toBeNull();
    expect(sanitizeGeneratedBranch("@")).toBeNull();
    expect(sanitizeGeneratedBranch("///")).toBeNull();
  });

  it("caps the length without a trailing separator", () => {
    const name = sanitizeGeneratedBranch(`feat/${"a".repeat(94)}-${"b".repeat(20)}`);
    expect(name?.length).toBeLessThanOrEqual(100);
    expect(name?.endsWith("-")).toBe(false);
  });
});

describe("ownsSessionBranch", () => {
  it("owns cw/ branches and the branch cw-code generated for the session", () => {
    expect(ownsSessionBranch("cw/fix-login", undefined)).toBe(true);
    expect(ownsSessionBranch("feat/login", "feat/login")).toBe(true);
    expect(ownsSessionBranch("feat/login", undefined)).toBe(false);
    expect(ownsSessionBranch("main", "feat/login")).toBe(false);
  });
});
