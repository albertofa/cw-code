import { describe, expect, it } from "vitest";
import type { ReleaseInfo } from "./releaseSource.ts";
import { parseVersion } from "./semver.ts";
import {
  classifyReleases,
  highestPublished,
  nextAlphaNumberForBase,
  planNextAlpha,
  resolveCandidate,
  shouldSkipAutomaticAlpha,
  validateCandidateIsNewerThanStable
} from "./versionPolicy.ts";

function release(tag: string, overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tagName: tag,
    targetCommitish: "main",
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-24T00:00:00Z",
    htmlUrl: `https://github.com/albertofa/cw-code/releases/tag/${tag}`,
    ...overrides
  };
}

const ALPHA_HISTORY: ReleaseInfo[] = [
  release("v0.0.1-alpha.18", { publishedAt: "2026-09-22T18:53:05Z" }),
  release("v0.0.1-alpha.19", { publishedAt: "2026-09-23T18:00:34Z" }),
  release("v0.0.1-alpha.20", { publishedAt: "2026-09-24T15:13:57Z" }),
  release("v0.0.1-alpha.21", { publishedAt: "2026-09-24T22:56:04Z" })
];

describe("classifyReleases / highestPublished", () => {
  it("ignores tags that do not parse as a supported version shape", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("nightly-build")]);
    expect(classified).toHaveLength(ALPHA_HISTORY.length);
  });

  it("ignores draft releases when finding the highest published version", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.1-alpha.99", { draft: true })]);
    expect(highestPublished(classified, "alpha")?.release.tagName).toBe("v0.0.1-alpha.21");
  });
});

describe("planNextAlpha", () => {
  it("numbers the next alpha as one past the highest published alpha for the base", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = planNextAlpha(parseVersion("0.0.1-alpha.21"), classified);
    expect(result).toEqual({ ok: true, version: { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 22 } });
  });

  it("starts a new base at alpha.0 when no alpha has been published for it", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = planNextAlpha(parseVersion("0.0.2"), classified);
    expect(result).toEqual({ ok: true, version: { channel: "alpha", major: 0, minor: 0, patch: 2, alphaNumber: 0 } });
  });

  it("rejects when the base is already published as stable", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.1")]);
    const result = planNextAlpha(parseVersion("0.0.1-alpha.21"), classified);
    expect(result.ok).toBe(false);
  });

  it("computes nextAlphaNumberForBase directly", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    expect(nextAlphaNumberForBase(classified, { channel: "stable", major: 0, minor: 0, patch: 1 })).toBe(22);
    expect(nextAlphaNumberForBase(classified, { channel: "stable", major: 0, minor: 0, patch: 2 })).toBe(0);
  });
});

describe("shouldSkipAutomaticAlpha", () => {
  const now = new Date("2026-09-24T23:00:00Z");

  it("skips when HEAD matches the latest published change", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: "abc123",
      latestChangeSha: "abc123",
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result).toEqual({ skip: true, reason: expect.stringContaining("matches the latest published release") });
  });

  it("skips within the 6-hour coalescing window even for a new commit", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: "def456",
      latestChangeSha: "abc123",
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result.skip).toBe(true);
  });

  it("does not skip once 6 hours have passed and the commit changed", () => {
    const result = shouldSkipAutomaticAlpha({
      now: new Date("2026-09-25T05:00:00Z"),
      headSha: "def456",
      latestChangeSha: "abc123",
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result).toEqual({ skip: false });
  });

  it("does not skip when there is no prior alpha at all", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: "def456",
      latestChangeSha: null,
      latestAlphaPublishedAt: null
    });
    expect(result).toEqual({ skip: false });
  });
});

describe("resolveCandidate", () => {
  const desktopBase = { channel: "stable" as const, major: 0, minor: 0, patch: 1 };

  function tagShaMap(pairs: Array<[string, string]>): Map<string, string> {
    return new Map(pairs);
  }

  it("resolves a valid candidate given as a tag", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.21",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", "9999999"]]),
      desktopBase
    });
    expect(result).toEqual({
      ok: true,
      candidate: {
        release: ALPHA_HISTORY[3],
        version: { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 21 },
        sha: "9999999"
      }
    });
  });

  it("resolves a valid candidate given as its resolved SHA", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "9999999",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", "9999999"]]),
      desktopBase
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a candidate whose base does not match the intended stable base", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.2-alpha.0")]);
    const result = resolveCandidate({
      candidateInput: "v0.0.2-alpha.0",
      classified,
      tagShas: tagShaMap([["v0.0.2-alpha.0", "aaaaaaa"]]),
      desktopBase
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not match the intended stable base") });
  });

  it("rejects a draft candidate release", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.1-alpha.22", { draft: true })]);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.22",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.22", "bbbbbbb"]]),
      desktopBase
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("draft release") });
  });

  it("rejects a candidate tag missing from git", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.21",
      classified,
      tagShas: tagShaMap([]),
      desktopBase
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing tag") });
  });

  it("rejects a SHA that does not match any published candidate", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "0123456789abcdef0123456789abcdef01234567",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", "9999999"]]),
      desktopBase
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("does not match any published release tag")
    });
  });
});

describe("validateCandidateIsNewerThanStable", () => {
  it("accepts when no stable has been published yet", () => {
    const result = validateCandidateIsNewerThanStable(
      { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 21 },
      null
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects when a stable release already supersedes the candidate's base", () => {
    const classified = classifyReleases([release("v0.0.1")]);
    const highestStable = highestPublished(classified, "stable");
    const result = validateCandidateIsNewerThanStable(
      { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 21 },
      highestStable
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("already supersedes") });
  });

  it("accepts when the candidate base is newer than the highest stable", () => {
    const classified = classifyReleases([release("v0.0.1")]);
    const highestStable = highestPublished(classified, "stable");
    const result = validateCandidateIsNewerThanStable(
      { channel: "alpha", major: 0, minor: 2, patch: 0, alphaNumber: 0 },
      highestStable
    );
    expect(result).toEqual({ ok: true });
  });
});
