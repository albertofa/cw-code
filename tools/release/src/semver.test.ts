import { describe, expect, it } from "vitest";
import { baseOf, compareVersions, formatVersion, parseTag, parseVersion, sameBase, tagOf, tryParseVersion } from "./semver.ts";

describe("parseVersion", () => {
  it("parses a stable version", () => {
    expect(parseVersion("1.2.3")).toEqual({ channel: "stable", major: 1, minor: 2, patch: 3 });
  });

  it("parses an alpha version", () => {
    expect(parseVersion("1.2.3-alpha.4")).toEqual({ channel: "alpha", major: 1, minor: 2, patch: 3, alphaNumber: 4 });
  });

  it("parses zero components", () => {
    expect(parseVersion("0.0.1-alpha.0")).toEqual({ channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 0 });
  });

  it.each([
    "1.2",
    "1.2.3.4",
    "1.2.x",
    "v1.2.3",
    "1.2.3-beta.1",
    "1.2.3-alpha",
    "1.2.3-alpha.",
    "1.02.3",
    "1.2.3-alpha.01",
    "",
    "1.2.3 ",
    "1.2.-3"
  ])("rejects malformed version %s", (input) => {
    expect(() => parseVersion(input)).toThrow();
  });

  it("tryParseVersion returns null instead of throwing", () => {
    expect(tryParseVersion("not-a-version")).toBeNull();
    expect(tryParseVersion("1.2.3")).not.toBeNull();
  });
});

describe("formatVersion / tagOf / parseTag", () => {
  it("formats stable and alpha versions", () => {
    expect(formatVersion({ channel: "stable", major: 1, minor: 2, patch: 3 })).toBe("1.2.3");
    expect(formatVersion({ channel: "alpha", major: 1, minor: 2, patch: 3, alphaNumber: 4 })).toBe("1.2.3-alpha.4");
  });

  it("round-trips through a tag", () => {
    const version = parseVersion("0.0.1-alpha.21");
    expect(tagOf(version)).toBe("v0.0.1-alpha.21");
    expect(parseTag(tagOf(version))).toEqual(version);
  });

  it("rejects tags without a leading v", () => {
    expect(parseTag("0.0.1")).toBeNull();
  });

  it("rejects malformed tags", () => {
    expect(parseTag("vnot-a-version")).toBeNull();
  });
});

describe("baseOf / sameBase", () => {
  it("strips the prerelease from an alpha version", () => {
    expect(baseOf(parseVersion("1.2.3-alpha.4"))).toEqual({ channel: "stable", major: 1, minor: 2, patch: 3 });
  });

  it("treats stable and alpha versions with equal major.minor.patch as the same base", () => {
    expect(sameBase(parseVersion("1.2.3"), parseVersion("1.2.3-alpha.9"))).toBe(true);
    expect(sameBase(parseVersion("1.2.3"), parseVersion("1.2.4"))).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders by major, minor, patch", () => {
    expect(compareVersions(parseVersion("2.0.0"), parseVersion("1.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("1.2.0"), parseVersion("1.3.0"))).toBeLessThan(0);
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.4"))).toBeLessThan(0);
  });

  it("orders alpha numbers within the same base", () => {
    expect(compareVersions(parseVersion("1.2.3-alpha.1"), parseVersion("1.2.3-alpha.2"))).toBeLessThan(0);
    expect(compareVersions(parseVersion("1.2.3-alpha.5"), parseVersion("1.2.3-alpha.5"))).toBe(0);
  });

  it("ranks stable above alpha for the same base", () => {
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3-alpha.99"))).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("1.2.3-alpha.99"), parseVersion("1.2.3"))).toBeLessThan(0);
  });

  it("ranks a higher base above a lower base regardless of channel", () => {
    expect(compareVersions(parseVersion("1.3.0-alpha.0"), parseVersion("1.2.9"))).toBeGreaterThan(0);
  });
});
