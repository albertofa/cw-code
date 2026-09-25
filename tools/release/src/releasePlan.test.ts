import { describe, expect, it } from "vitest";
import { createFixtureReleaseSource, type FixtureRelease } from "./fixtures/fixtureReleaseSource.ts";
import { planMarker } from "./planMarker.ts";
import type { ReleasePlan } from "./planValidation.ts";
import { DivergedHistoryError, buildAlphaPlan, buildStablePromotionPlan, verifyPlan } from "./releasePlan.ts";
import type { ReleaseSource } from "./releaseSource.ts";
import { parseVersion } from "./semver.ts";

function sha(label: string): string {
  return label.repeat(40).slice(0, 40);
}

const SHA = {
  c1: sha("1"),
  c2: sha("2"),
  c3: sha("3"),
  c4: sha("4"),
  c5: sha("5"),
  c6: sha("6"),
  c7: sha("7"),
  c8: sha("8"),
  c9: sha("9"),
  c10: sha("a"),
  c11: sha("b")
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

function baseRelease(tag: string, releaseSha: string, overrides: Partial<FixtureRelease> = {}): FixtureRelease {
  return {
    tagName: tag,
    targetCommitish: "main",
    draft: false,
    prerelease: false,
    publishedAt: "2026-09-24T00:00:00Z",
    htmlUrl: `https://github.com/albertofa/cw-code/releases/tag/${tag}`,
    name: tag,
    body: "",
    sha: releaseSha,
    ...overrides
  };
}

const BASE_RELEASES: FixtureRelease[] = [
  baseRelease("v0.0.1-alpha.18", SHA.c3, { publishedAt: "2026-09-22T18:53:05Z" }),
  baseRelease("v0.0.1-alpha.19", SHA.c5, { publishedAt: "2026-09-23T18:00:34Z" }),
  baseRelease("v0.0.1-alpha.20", SHA.c7, { publishedAt: "2026-09-24T15:13:57Z" }),
  baseRelease("v0.0.1-alpha.21", SHA.c9, { publishedAt: "2026-09-24T22:56:04Z" })
];

function buildPlanFor(sourceSha: string, acknowledgedDivergedTags: string[]): ReleasePlan {
  return {
    schema: 1,
    channel: "alpha",
    version: "0.0.1-alpha.23",
    tag: "v0.0.1-alpha.23",
    sourceSha,
    acknowledgedDivergedTags,
    previousTag: "v0.0.1-alpha.22",
    prerelease: true,
    makeLatest: false,
    notes: "",
    createdAt: "2026-09-25T06:00:00.000Z"
  };
}

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
    expect(result).toEqual({ status: "skip", reason: expect.stringContaining("matches the latest published release") });
  });

  it("skips within the 6-hour coalescing window even with a new commit", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog });
    const now = new Date("2026-09-24T23:30:00Z");
    const result = await buildAlphaPlan({ source, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    expect(result).toEqual({ status: "skip", reason: expect.stringContaining("6-hour coalescing window") });
  });

  it("force bypasses the 6-hour window but not the unchanged-HEAD skip", async () => {
    const withinWindow = new Date("2026-09-24T23:30:00Z");

    const unchangedSource = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const stillSkipped = await buildAlphaPlan({
      source: unchangedSource,
      now: withinWindow,
      desktopVersion: parseVersion("0.0.1-alpha.21"),
      force: true
    });
    expect(stillSkipped.status).toBe("skip");

    const changedSource = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog });
    const planned = await buildAlphaPlan({
      source: changedSource,
      now: withinWindow,
      desktopVersion: parseVersion("0.0.1-alpha.21"),
      force: true
    });
    expect(planned.status).toBe("planned");
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

  it("rejects a base that is behind the highest published alpha base, even with force", async () => {
    const source = createFixtureReleaseSource({
      releases: [...BASE_RELEASES, baseRelease("v0.0.2-alpha.0", SHA.c10)],
      head: SHA.c10,
      commitLog
    });
    await expect(
      buildAlphaPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        force: true
      })
    ).rejects.toThrow(/behind the highest published alpha base/);
  });

  it("fails a rerun of an old CI run whose commit is older than the latest published alpha", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", SHA.c10, { publishedAt: "2026-09-24T23:00:00Z" })];
    const source = createFixtureReleaseSource({ releases, head: SHA.c10, commitLog: [...commitLog, { sha: SHA.c11, subject: "feat: later" }] });
    const attempt = buildAlphaPlan({ source, now: new Date("2026-09-25T12:00:00Z"), desktopVersion: parseVersion("0.0.1-alpha.21"), sha: SHA.c8, force: true });
    await expect(attempt).rejects.toBeInstanceOf(DivergedHistoryError);
    await expect(attempt).rejects.toThrow(new RegExp(`v0.0.1-alpha.22 \\(${SHA.c10}\\) is not an ancestor of ${SHA.c8}.*releases.md#recovery`));
  });

  it("fails an alpha whose commit does not descend from the latest published stable", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1", SHA.c10)];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c9,
      commitLog: [...commitLog, { sha: SHA.c11, subject: "feat: next" }]
    });
    await expect(buildAlphaPlan({ source, now: new Date("2026-09-25T12:00:00Z"), desktopVersion: parseVersion("0.0.2"), sha: SHA.c9 })).rejects.toThrow(
      /Published stable v0.0.1/
    );
  });

  describe("with a published tag that ended off main", () => {
    const OFF_MAIN = sha("e");
    const now = new Date("2026-09-25T12:00:00Z");
    const offMainAlpha = baseRelease("v0.0.1-alpha.22", OFF_MAIN);
    const plan = (acknowledgedDivergedTags: string[] | undefined, releases: FixtureRelease[] = [...BASE_RELEASES, offMainAlpha]) =>
      buildAlphaPlan({
        source: createFixtureReleaseSource({ releases, head: SHA.c10, commitLog, detachedShas: [OFF_MAIN] }),
        now,
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        acknowledgedDivergedTags
      });

    it("fails without an acknowledgement and names the tag and both SHAs", async () => {
      await expect(plan(undefined)).rejects.toThrow(new RegExp(`v0.0.1-alpha.22 \\(${OFF_MAIN}\\) is not an ancestor of ${SHA.c10}`));
    });

    it("proceeds when exactly that tag is acknowledged and records it in the plan, keeping the numbering", async () => {
      const result = await plan(["v0.0.1-alpha.22"]);
      expect(result.status).toBe("planned");
      if (result.status !== "planned") return;
      expect(result.plan).toMatchObject({ version: "0.0.1-alpha.23", sourceSha: SHA.c10, acknowledgedDivergedTags: ["v0.0.1-alpha.22"] });
      const verify = createFixtureReleaseSource({ releases: [...BASE_RELEASES, offMainAlpha], head: SHA.c10, commitLog });
      expect(await verifyPlan(result.plan, verify)).toEqual({ ok: true, resumeDraft: null });
    });

    it("fails a wrong, extra or partial acknowledgement", async () => {
      await expect(plan(["v0.0.1-alpha.21"])).rejects.toThrow(/v0.0.1-alpha.22 .* not an ancestor[\s\S]*v0.0.1-alpha.21, which has not diverged/);
      await expect(plan(["v0.0.1-alpha.22", "v0.0.1-alpha.21"])).rejects.toThrow(/names v0.0.1-alpha.21, which has not diverged/);
      const bothDiverged = [...BASE_RELEASES, offMainAlpha, baseRelease("v0.0.0", OFF_MAIN)];
      await expect(plan(["v0.0.1-alpha.22"], bothDiverged)).rejects.toThrow(/Published stable v0.0.0 .* unless the operator acknowledges v0.0.0/);
      const both = await plan(["v0.0.1-alpha.22", "v0.0.0"], bothDiverged);
      expect(both.status === "planned" && both.plan.acknowledgedDivergedTags).toEqual(["v0.0.0", "v0.0.1-alpha.22"]);
    });

    it("fails an acknowledgement when nothing diverged", async () => {
      await expect(plan(["v0.0.1-alpha.21"], BASE_RELEASES)).rejects.toThrow(/which has not diverged/);
    });

    it("lets verifyPlan honor only the tags the plan recorded", async () => {
      const verify = createFixtureReleaseSource({ releases: [...BASE_RELEASES, offMainAlpha], head: SHA.c10, commitLog });
      const recordedOther = await verifyPlan(buildPlanFor(SHA.c10, ["v0.0.1-alpha.21"]), verify);
      expect(recordedOther.ok).toBe(false);
      if (!recordedOther.ok) expect(recordedOther.reasons.join("\n")).toMatch(/the plan did not acknowledge v0.0.1-alpha.22/);
    });
  });

  it("never reuses an alpha number held by a leftover git tag or a draft release", async () => {
    const now = new Date("2026-09-25T06:00:00Z");
    const withTag = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c10, commitLog, extraTags: { "v0.0.1-alpha.24": SHA.c9, "v0.0.2-alpha.7": SHA.c9 } });
    const tagged = await buildAlphaPlan({ source: withTag, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    expect(tagged.status === "planned" && tagged.plan.version).toBe("0.0.1-alpha.25");

    const withDraft = createFixtureReleaseSource({ releases: [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", "", { draft: true })], head: SHA.c10, commitLog });
    const drafted = await buildAlphaPlan({ source: withDraft, now, desktopVersion: parseVersion("0.0.1-alpha.21") });
    expect(drafted.status === "planned" && drafted.plan.version).toBe("0.0.1-alpha.23");
  });
});

describe("buildStablePromotionPlan", () => {
  it("refuses a stable version whose tag already exists, for example after a withdrawal", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG, extraTags: { "v0.0.1": SHA.c8 } });
    await expect(
      buildStablePromotionPlan({ source, now: new Date("2026-09-25T06:00:00Z"), desktopVersion: parseVersion("0.0.1-alpha.21"), candidateInput: "v0.0.1-alpha.21" })
    ).rejects.toThrow(/Tag v0.0.1 already exists .* bump the base/);
  });

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

  it("accepts a tag candidate whose resolved SHA matches an explicit --expected-sha", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    const result = await buildStablePromotionPlan({
      source,
      now: new Date("2026-09-25T06:00:00Z"),
      desktopVersion: parseVersion("0.0.1-alpha.21"),
      candidateInput: "v0.0.1-alpha.21",
      expectedSha: SHA.c9
    });
    expect(result.status).toBe("planned");
  });

  it("rejects a tag candidate whose resolved SHA does not match an explicit --expected-sha", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "v0.0.1-alpha.21",
        expectedSha: SHA.c8
      })
    ).rejects.toThrow(/does not match --expected-sha/);
  });

  it("rejects an ambiguous SHA that resolves to more than one published alpha tag", async () => {
    const releases = BASE_RELEASES.map((entry) => (entry.tagName === "v0.0.1-alpha.20" ? { ...entry, sha: SHA.c9 } : entry));
    const source = createFixtureReleaseSource({ releases, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: SHA.c9
      })
    ).rejects.toThrow(/matches multiple published alpha tags/);
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

  it("rejects a SHA shorter than 40 hex characters even if a tag resolves to a matching prefix", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: SHA.c9.slice(0, 10)
      })
    ).rejects.toThrow(/does not match any published release tag/);
  });

  it("rejects a SHA that does not resolve to any published candidate", async () => {
    const source = createFixtureReleaseSource({ releases: BASE_RELEASES, head: SHA.c9, commitLog: BASE_COMMIT_LOG });
    await expect(
      buildStablePromotionPlan({
        source,
        now: new Date("2026-09-25T06:00:00Z"),
        desktopVersion: parseVersion("0.0.1-alpha.21"),
        candidateInput: "f".repeat(40)
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
    expect(result).toEqual({ ok: true, resumeDraft: null });
  });

  it("validates the plan's own shape before touching the release source at all", async () => {
    const throwingSource: ReleaseSource = {
      listReleases: () => {
        throw new Error("should not be called");
      },
      tagSha: () => {
        throw new Error("should not be called");
      },
      headSha: () => {
        throw new Error("should not be called");
      },
      isAncestor: () => {
        throw new Error("should not be called");
      },
      listTags: () => {
        throw new Error("should not be called");
      },
      logSubjects: () => {
        throw new Error("should not be called");
      },
      showFile: () => {
        throw new Error("should not be called");
      }
    };
    const result = await verifyPlan({ ...buildPlan(), sourceSha: "not-a-sha" }, throwingSource);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/sourceSha/);
  });

  it("rejects when the planned tag already exists as a git tag", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", SHA.c10)];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result.ok).toBe(false);
  });

  it("rejects when the planned tag is already reserved by a draft release with no git tag yet", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", "", { draft: true })];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result).toEqual({ ok: false, reasons: [expect.stringContaining("draft release")] });
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

  it("rejects an alpha when a newer stable was published since the plan was created", async () => {
    const releases = [...BASE_RELEASES, baseRelease("v0.0.1", SHA.c9)];
    const source = createFixtureReleaseSource({
      releases,
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result).toEqual({ ok: false, reasons: [expect.stringContaining("Stable 0.0.1 is newer than 0.0.1-alpha.22")] });
  });

  it("rejects a stale plan from an old run once a newer alpha from later history was published", async () => {
    const commitLog = [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }, { sha: SHA.c11, subject: "feat: newer" }];
    const staleSource = createFixtureReleaseSource({
      releases: [...BASE_RELEASES, baseRelease("v0.0.1-alpha.22", SHA.c11)],
      head: SHA.c11,
      commitLog
    });
    const stale = await verifyPlan(buildPlan({ version: "0.0.1-alpha.23", tag: "v0.0.1-alpha.23" }), staleSource);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reasons.join("\n")).toMatch(`v0.0.1-alpha.22 (${SHA.c11}) is not an ancestor of ${SHA.c10}`);
  });

  it("accepts an alpha whose source SHA is still reachable from main after main moved on", async () => {
    const source = createFixtureReleaseSource({
      releases: BASE_RELEASES,
      head: SHA.c11,
      commitLog: [
        ...BASE_COMMIT_LOG,
        { sha: SHA.c10, subject: "feat: add cool feature" },
        { sha: SHA.c11, subject: "feat: another change" }
      ]
    });
    expect(await verifyPlan(buildPlan(), source)).toEqual({ ok: true, resumeDraft: null });
  });

  it("rejects an alpha whose source SHA is not reachable from main (force-push or a side branch)", async () => {
    const source = createFixtureReleaseSource({
      releases: BASE_RELEASES,
      head: SHA.c10,
      mainHistory: [...BASE_COMMIT_LOG.map((entry) => entry.sha), SHA.c11],
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result).toEqual({ ok: false, reasons: [expect.stringContaining("is not reachable from main")] });
  });

  it("resumes a draft that targets the planned SHA and carries the plan marker", async () => {
    const draft = baseRelease("v0.0.1-alpha.22", "", {
      draft: true,
      publishedAt: "",
      targetCommitish: SHA.c10,
      body: `notes\n\n${planMarker(SHA.c10)}\n`
    });
    const source = createFixtureReleaseSource({
      releases: [...BASE_RELEASES, draft],
      head: SHA.c10,
      commitLog: [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }]
    });
    const result = await verifyPlan(buildPlan(), source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resumeDraft?.tagName).toBe("v0.0.1-alpha.22");
  });

  it("never resumes a draft for another SHA, a draft without the marker, a published release or duplicate drafts", async () => {
    const commitLog = [...BASE_COMMIT_LOG, { sha: SHA.c10, subject: "feat: add cool feature" }];
    const marked = { draft: true, publishedAt: "", targetCommitish: SHA.c10, body: planMarker(SHA.c10) };
    const cases: Array<{ releases: FixtureRelease[]; reason: RegExp }> = [
      { releases: [baseRelease("v0.0.1-alpha.22", "", { ...marked, targetCommitish: SHA.c9 })], reason: /cannot resume/ },
      { releases: [baseRelease("v0.0.1-alpha.22", "", { ...marked, body: planMarker(SHA.c9) })], reason: /cannot resume/ },
      { releases: [baseRelease("v0.0.1-alpha.22", "", { ...marked, body: "no marker" })], reason: /cannot resume/ },
      { releases: [baseRelease("v0.0.1-alpha.22", "", { ...marked, draft: false })], reason: /cannot resume/ },
      { releases: [baseRelease("v0.0.1-alpha.22", "", marked), baseRelease("v0.0.1-alpha.22", "", marked)], reason: /reserved by 2 releases/ }
    ];
    for (const { releases, reason } of cases) {
      const source = createFixtureReleaseSource({ releases: [...BASE_RELEASES, ...releases], head: SHA.c10, commitLog });
      const result = await verifyPlan(buildPlan(), source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons.join("\n")).toMatch(reason);
    }
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
