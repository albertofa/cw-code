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

function sha(label: string): string {
  return label.repeat(40).slice(0, 40);
}

const SHA_18 = sha("1");
const SHA_19 = sha("2");
const SHA_20 = sha("3");
const SHA_21 = sha("4");
const SHA_22 = sha("5");
const SHA_X = sha("6");
const SHA_UNKNOWN = sha("f");

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

  it("rejects a base that is behind the highest published alpha base", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.2-alpha.0")]);
    const result = planNextAlpha(parseVersion("0.0.1-alpha.21"), classified);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("behind the highest published alpha base") });
  });

  it("does not reject a base equal to the highest published alpha base", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = planNextAlpha(parseVersion("0.0.1"), classified);
    expect(result.ok).toBe(true);
  });

  it("computes nextAlphaNumberForBase directly", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    expect(nextAlphaNumberForBase(classified, { channel: "stable", major: 0, minor: 0, patch: 1 })).toBe(22);
    expect(nextAlphaNumberForBase(classified, { channel: "stable", major: 0, minor: 0, patch: 2 })).toBe(0);
  });
});

describe("shouldSkipAutomaticAlpha", () => {
  const now = new Date("2026-09-24T23:00:00Z");

  it("skips when HEAD matches the latest published change, and the reason explains why", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: SHA_21,
      latestChangeSha: SHA_21,
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result).toEqual({ skip: true, reason: expect.stringContaining("matches the latest published release") });
  });

  it("skips within the 6-hour coalescing window even for a new commit, and the reason explains why", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: SHA_22,
      latestChangeSha: SHA_21,
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result).toEqual({ skip: true, reason: expect.stringContaining("6-hour coalescing window") });
  });

  it("does not skip once 6 hours have passed and the commit changed", () => {
    const result = shouldSkipAutomaticAlpha({
      now: new Date("2026-09-25T05:00:00Z"),
      headSha: SHA_22,
      latestChangeSha: SHA_21,
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z"
    });
    expect(result).toEqual({ skip: false });
  });

  it("does not skip when there is no prior alpha at all", () => {
    const result = shouldSkipAutomaticAlpha({
      now,
      headSha: SHA_22,
      latestChangeSha: null,
      latestAlphaPublishedAt: null
    });
    expect(result).toEqual({ skip: false });
  });

  it("force bypasses only the 6-hour window, never the unchanged-HEAD skip", () => {
    const stillUnchanged = shouldSkipAutomaticAlpha({
      now,
      headSha: SHA_21,
      latestChangeSha: SHA_21,
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z",
      force: true
    });
    expect(stillUnchanged.skip).toBe(true);

    const bypassesWindow = shouldSkipAutomaticAlpha({
      now,
      headSha: SHA_22,
      latestChangeSha: SHA_21,
      latestAlphaPublishedAt: "2026-09-24T22:56:04Z",
      force: true
    });
    expect(bypassesWindow).toEqual({ skip: false });
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
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase
    });
    expect(result).toEqual({
      ok: true,
      candidate: {
        release: ALPHA_HISTORY[3],
        version: { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 21 },
        sha: SHA_21
      }
    });
  });

  it("resolves a valid candidate given as its resolved SHA, case-insensitively", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: SHA_21.toUpperCase(),
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase
    });
    expect(result).toEqual({
      ok: true,
      candidate: {
        release: ALPHA_HISTORY[3],
        version: { channel: "alpha", major: 0, minor: 0, patch: 1, alphaNumber: 21 },
        sha: SHA_21
      }
    });
  });

  it("rejects a SHA shorter than 40 hex characters, even if it would otherwise match", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: SHA_21.slice(0, 12),
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an ambiguous SHA that resolves to more than one published alpha tag", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: SHA_21,
      classified,
      tagShas: tagShaMap([
        ["v0.0.1-alpha.20", SHA_21],
        ["v0.0.1-alpha.21", SHA_21]
      ]),
      desktopBase
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("matches multiple published alpha tags")
    });
  });

  it("is not ambiguous when the same SHA is given explicitly as a tag", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.21",
      classified,
      tagShas: tagShaMap([
        ["v0.0.1-alpha.20", SHA_21],
        ["v0.0.1-alpha.21", SHA_21]
      ]),
      desktopBase
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a candidate whose base does not match the intended stable base", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.2-alpha.0")]);
    const result = resolveCandidate({
      candidateInput: "v0.0.2-alpha.0",
      classified,
      tagShas: tagShaMap([["v0.0.2-alpha.0", SHA_X]]),
      desktopBase
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not match the intended stable base") });
  });

  it("rejects a draft candidate release", () => {
    const classified = classifyReleases([...ALPHA_HISTORY, release("v0.0.1-alpha.22", { draft: true })]);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.22",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.22", SHA_22]]),
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

  it("fixture tagSha treats a tag absent from the map the same as a missing tag", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const tagShas = tagShaMap([["v0.0.1-alpha.20", SHA_20]]);
    expect(tagShas.get("v0.0.1-alpha.21")).toBeUndefined();
    const result = resolveCandidate({ candidateInput: "v0.0.1-alpha.21", classified, tagShas, desktopBase });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing tag") });
  });

  it("rejects a SHA that does not match any published candidate", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: SHA_UNKNOWN,
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("does not match any published release tag")
    });
  });

  it("accepts a candidate tag whose resolved SHA matches --expected-sha", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.21",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase,
      expectedSha: SHA_21.toUpperCase()
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a candidate tag whose resolved SHA does not match --expected-sha", () => {
    const classified = classifyReleases(ALPHA_HISTORY);
    const result = resolveCandidate({
      candidateInput: "v0.0.1-alpha.21",
      classified,
      tagShas: tagShaMap([["v0.0.1-alpha.21", SHA_21]]),
      desktopBase,
      expectedSha: SHA_20
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not match --expected-sha") });
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
