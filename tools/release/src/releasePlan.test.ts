import { describe, expect, it } from "vitest";
import { createFixtureReleaseSource, type FixtureRelease } from "./fixtures/fixtureReleaseSource.ts";
import { buildAlphaPlan, buildStablePromotionPlan, verifyPlan, type ReleasePlan } from "./releasePlan.ts";
import { parseVersion } from "./semver.ts";

const SHA = {
  c1: "1111111",
  c2: "2222222",
  c3: "3333333",
  c4: "4444444",
  c5: "5555555",
  c6: "6666666",
  c7: "7777777",
  c8: "8888888",
  c9: "9999999",
  c10: "aaaaaaa",
  c11: "bbbbbbb"
};

const BASE_COMMIT_LOG = [
  { sha: SHA.c1, subject: "chore: init" },
  { sha: SHA.c2, subject: "feat: add worktree bar" },
  { sha: SHA.c3, subject: "fix: crash on empty session" },
  { sha: SHA.c4, subject: "feat(sessions): auto-generated session titles" },
  { sha: SHA.c5, subject: "fix(pr): key the dock guard on updates" },
  { sha: SHA.c6, subject: "perf(git): cut git spawns per status" },
  { sha: SHA.c7, subject: "chore(release): v0.0.1-alpha.20" },
  { sha: SHA.c8, subject: "fix: keep history correct on edge paths" },
  { sha: SHA.c9, subject: "chore(release): v0.0.1-alpha.21" }
];

function baseRelease(tag: string, sha: string, overrides: Partial<FixtureRelease> = {}): FixtureRelease {
  return {
    tagName: tag,
    targetCommitish: "main",
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-24T00:00:00Z",
    htmlUrl: `https://github.com/albertofa/cw-code/releases/tag/${tag}`,
    sha,
    ...overrides
  };
}

const BASE_RELEASES: FixtureRelease[] = [
  baseRelease("v0.0.1-alpha.18", SHA.c3, { publishedAt: "2026-09-22T18:53:05Z" }),
  baseRelease("v0.0.1-alpha.19", SHA.c5, { publishedAt: "2026-09-23T18:00:34Z" }),
  baseRelease("v0.0.1-alpha.20", SHA.c7, { publishedAt: "2026-09-24T15:13:57Z" }),
  baseRelease("v0.0.1-alpha.21", SHA.c9, { publishedAt: "2026-09-24T22:56:04Z" })
];

describe("buildAlphaPlan", () => {
  const commitLog = [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }];

  it("plans the next alpha from the latest published alpha to HEAD", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog });
    const now = new Date("2026-09-25T06:00:00Z");
    const result = await buildAlphaPlan({ source, now, desktopVersion: parseVersion("0.0.1-alpha.21") });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.plan).toEqual({
      schema: 1,
      channel: "alpha",
      version: "0.0.1-alpha.22",
      tag: "v0.0.1-alpha.22",
      sourceSha: SHA.c10,
      previousTag: "v0.0.1-alpha.21",
      prerelease: true,
      makeLatest: false,
      notes: "## Features\n\n- feat: add cool feature",
      createdAt: now.toISOString()
    });
  });

  it("skips when HEAD has not moved since the latest published release", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const now = new Date("2026-09-25T06:00:00Z");
    const result = await buildAlphaPlan({ source, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    expect(result.status).toBe("skip");
  });

  it("skips within the 6-hour coalescing window even with a new commit", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog });
    const now = new Date("2026-09-24T23:30:00Z");
    const result = await buildAlphaPlan({ source, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    expect(result.status).toBe("skip");
  });

  it("is deterministic across reruns given the same inputs", async () => {
    const now = new Date("2026-09-25T06:00:00Z");
    const runOnce = async () => {
      const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog });
      return buildAlphaPlan({ source, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    };
    expect(await runOnce()).toEqual(await runOnce());
  });

  it("rejects when the base is already published as stable", async () => {
    const source = createFixtureReleaseSource({
      releases: [...BASE_RELEASES, baseRelease("v0.0.1", SHA.c9)],
      head: SHA.c10,
      commitLog
    });
    await expect(
      buildAlphaPlan({ source, now: new Date("2026-09-25T06:00:00Z"), desktopVersion: parseVersion("0.0.1-alpha.21") })
    ).rejects.toThrow();
  });
});

describe("buildStablePromotionPlan", () => {
  it("promotes an explicit candidate tag to stable at its exact source SHA", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const now = new Date("2026-09-25T06:00:00Z");
    const result = await buildStablePromotionPlan({
      source,
      now,
      desktopVersion: parseVersion("0.0.1-alpha.21"),
      candidateInput: "v0.0.1-alpha.21"
    });

    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.plan.channel).toBe("stable");
    expect(result.plan.version).toBe("0.0.1");
    expect(result.plan.tag).toBe("v0.0.1");
    expect(result.plan.sourceSha).toBe(SHA.c9);
    expect(result.plan.candidate).toEqual({ tag: "v0.0.1-alpha.21", sha: SHA.c9 });
    expect(result.plan.previousTag).toBeNull();
    expect(result.plan.prerelease).toBe(false);
    expect(result.plan.makeLatest).toBe(true);
  });

  it("promotes an explicit candidate given as its resolved SHA", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const result = await buildStablePromotionPlan({
      source,
      now: new Date("2026-09-25T06:00:00Z"),
      desktopVersion: parseVersion("0.0.1-alpha.21"),
      candidateInput: SHA.c9
    });
    expect(result.status).toBe("planned");
  });

  it("rejects a candidate whose base does not match the intended stable base", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.2"),
        candidateInput: "v0.0.1-alpha.21"
      })
    ).rejects.toThrow(/does not match the intended stable base/);
  });

  it("rejects a draft candidate release", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", SHA.c10, { draft: true })];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: draft build" }]
    });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "v0.0.1-alpha.22"
      })
    ).rejects.toThrow(/draft release/);
  });

  it("rejects a candidate tag that does not exist in git", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", "")];
    const source = createFixtureReleaseSource({ releases, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "v0.0.1-alpha.22"
      })
    ).rejects.toThrow(/missing tag/);
  });

  it("rejects a SHA that does not resolve to any published candidate", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "ffffffffffffffffffffffffffffffffffffff"
      })
    ).rejects.toThrow(/does not match any published release tag/);
  });

  it("rejects a candidate that a newer stable release already supersedes", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.2", SHA.c9)];
    const source = createFixtureReleaseSource({ releases, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "v0.0.1-alpha.21"
      })
    ).rejects.toThrow(/already supersedes/);
  });
});

describe("verifyPlan", () => {
  function buildPlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
    return {
      schema: 1,
      channel: "alpha",
      version: "0.0.1-alpha.22",
      tag: "v0.0.1-alpha.22",
      sourceSha: SHA.c10,
      previousTag: "v0.0.1-alpha.21",
      prerelease: true,
      makeLatest: false,
      notes: "## Features\n\n- feat: add cool feature",
      createdAt: "2026-09-25T06:00:00.000Z",
      ...overrides
    };
  }

  it("accepts a plan that still matches the current repository state", async () => {
    const source = createFixtureReleaseSource({
      releases: BASE_RELEASES,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the planned tag already exists", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", SHA.c10)];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result.ok).toBe(false);
  });

  it("rejects when a higher alpha has been published since the plan was created", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.23", SHA.c11)];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [
        ...BASE_COMMIT_LOG,
        { sha: SHA.c10, subject: "feat: add cool feature" },
        { sha: SHA.c11, subject: "feat: race" }
      ]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result.ok).toBe(false);
  });

  it("rejects when HEAD moved past the planned source SHA", async () => {
    const source = createFixtureReleaseSource({
      releases: BASE_RELEASES,
      head: SHA.c11,
      commitLog: [
        ...BASE_COMMIT_LOG,
        { sha: SHA.c10, subject: "feat: add cool feature" },
        { sha: SHA.c11, subject: "feat: another change" }
      ]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result.ok).toBe(false);
  });

  it("rejects a stable plan whose candidate tag has moved to a different commit", async () => {
    const stablePlan = buildPlan({
      channel: "stable",
      version: "0.0.1",
      tag: "v0.0.1",
      sourceSha: SHA.c9,
      previousTag: null,
      prerelease: false,
      makeLatest: true,
      candidate: { tag: "v0.0.1-alpha.21", sha: SHA.c9 }
    });
    const movedReleases = BASE_RELEASES.map((entry) =>
      entry.tagName === "v0.0.1-alpha.21" ? { ...entry, sha: SHA.c8 } : entry
    );
    const source = createFixtureReleaseSource({ releases: movedReleases, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const result = await verifyPlan(stablePlan, source);
    expect(result.ok).toBe(false);
  });
});
