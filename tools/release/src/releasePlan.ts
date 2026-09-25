import { carriesPlanMarker } from "./planMarker.ts";
import { type ReleasePlan, type ReleasePlanCandidate, validatePlanShape } from "./planValidation.ts";
import { buildReleaseNotes } from "./releaseNotes.ts";
import type { ReleaseInfo, ReleaseSource } from "./releaseSource.ts";
import {
  type ParsedVersion,
  type StableVersion,
  baseOf,
  compareVersions,
  formatVersion,
  parseVersion,
  sameBase,
  tagOf
} from "./semver.ts";
import {
  type ClassifiedRelease,
  classifyReleases,
  highestPublished,
  planNextAlpha,
  resolveCandidate,
  shouldSkipAutomaticAlpha,
  validateCandidateIsNewerThanStable
} from "./versionPolicy.ts";

export type { ReleasePlan, ReleasePlanCandidate };

export type PlanResult = { status: "planned"; plan: ReleasePlan } | { status: "skip"; reason: string };

function latestPublishedOverall(classified: ClassifiedRelease[]): ClassifiedRelease | null {
  const stable = highestPublished(classified, "stable");
  const alpha = highestPublished(classified, "alpha");
  if (!stable) return alpha;
  if (!alpha) return stable;
  return compareVersions(alpha.version, stable.version) > 0 ? alpha : stable;
}

export interface BuildAlphaPlanOptions {
  source: ReleaseSource;
  now: Date;
  desktopVersion: ParsedVersion;
  sha?: string;
  force?: boolean;
}

export async function buildAlphaPlan(options: BuildAlphaPlanOptions): Promise<PlanResult> {
  const { source, now, desktopVersion } = options;
  const releases = await source.listReleases();
  const classified = classifyReleases(releases);

  const nextAlpha = planNextAlpha(desktopVersion, classified);
  if (!nextAlpha.ok) {
    throw new Error(nextAlpha.reason);
  }

  const headSha = options.sha ?? (await source.headSha());
  const latestOverall = latestPublishedOverall(classified);
  const latestChangeSha = latestOverall ? await source.tagSha(latestOverall.release.tagName) : null;
  const latestAlpha = highestPublished(classified, "alpha");

  const throttle = shouldSkipAutomaticAlpha({
    now,
    headSha,
    latestChangeSha,
    latestAlphaPublishedAt: latestAlpha?.release.publishedAt ?? null,
    force: options.force ?? false
  });
  if (throttle.skip) {
    return { status: "skip", reason: throttle.reason };
  }

  const previousTag = latestAlpha?.release.tagName ?? null;
  const notes = buildReleaseNotes(await source.logSubjects(previousTag, headSha));
  const tag = tagOf(nextAlpha.version);

  return {
    status: "planned",
    plan: {
      schema: 1,
      channel: "alpha",
      version: formatVersion(nextAlpha.version),
      tag,
      sourceSha: headSha,
      previousTag,
      prerelease: true,
      makeLatest: false,
      notes,
      createdAt: now.toISOString()
    }
  };
}

export interface BuildStablePlanOptions {
  source: ReleaseSource;
  now: Date;
  desktopVersion: ParsedVersion;
  candidateInput: string;
  expectedSha?: string;
}

export async function buildStablePromotionPlan(options: BuildStablePlanOptions): Promise<PlanResult> {
  const { source, now, desktopVersion, candidateInput, expectedSha } = options;
  const releases = await source.listReleases();
  const classified = classifyReleases(releases);
  const desktopBase: StableVersion = baseOf(desktopVersion);

  const relevantAlphas = classified.filter(
    (entry) => entry.version.channel === "alpha" && sameBase(entry.version, desktopBase)
  );
  const tagShas = new Map<string, string>();
  for (const entry of relevantAlphas) {
    const sha = await source.tagSha(entry.release.tagName);
    if (sha) tagShas.set(entry.release.tagName, sha);
  }

  const resolution = resolveCandidate({ candidateInput, classified, tagShas, desktopBase, expectedSha });
  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }

  const highestStable = highestPublished(classified, "stable");
  const newerCheck = validateCandidateIsNewerThanStable(resolution.candidate.version, highestStable);
  if (!newerCheck.ok) {
    throw new Error(newerCheck.reason);
  }

  const previousTag = highestStable?.release.tagName ?? null;
  const notes = buildReleaseNotes(await source.logSubjects(previousTag, resolution.candidate.sha));
  const tag = tagOf(desktopBase);

  return {
    status: "planned",
    plan: {
      schema: 1,
      channel: "stable",
      version: formatVersion(desktopBase),
      tag,
      sourceSha: resolution.candidate.sha,
      candidate: { tag: resolution.candidate.release.tagName, sha: resolution.candidate.sha },
      previousTag,
      prerelease: false,
      makeLatest: true,
      notes,
      createdAt: now.toISOString()
    }
  };
}

export type VerifyPlanResult = { ok: true; resumeDraft: ReleaseInfo | null } | { ok: false; reasons: string[] };

function isResumableDraft(release: ReleaseInfo, plan: ReleasePlan): boolean {
  return release.draft && release.targetCommitish === plan.sourceSha && carriesPlanMarker(release.body, plan.sourceSha);
}

export async function verifyPlan(rawPlan: unknown, source: ReleaseSource): Promise<VerifyPlanResult> {
  const shape = validatePlanShape(rawPlan);
  if (!shape.ok) {
    return { ok: false, reasons: shape.errors };
  }
  const plan = shape.plan;
  const reasons: string[] = [];

  const releases = await source.listReleases();

  const existingTagSha = await source.tagSha(plan.tag);
  if (existingTagSha) {
    reasons.push(`Tag "${plan.tag}" already exists in git (points at ${existingTagSha})`);
  }
  const reserving = releases.filter((release) => release.tagName === plan.tag);
  let resumeDraft: ReleaseInfo | null = null;
  if (reserving.length === 1 && isResumableDraft(reserving[0], plan)) {
    resumeDraft = reserving[0];
  } else if (reserving.length > 1) {
    reasons.push(`Tag "${plan.tag}" is reserved by ${reserving.length} releases; resolve the duplicates by hand`);
  } else if (reserving.length === 1) {
    const [release] = reserving;
    reasons.push(
      `Tag "${plan.tag}" is already reserved by an existing${release.draft ? " draft" : ""} release that this plan cannot resume (it must be a draft targeting ${plan.sourceSha} and carry the plan marker)`
    );
  }

  const classified = classifyReleases(releases);
  const planVersion = parseVersion(plan.version);
  const highest = highestPublished(classified, plan.channel);
  if (highest && compareVersions(highest.version, planVersion) >= 0) {
    reasons.push(
      `A higher or equal ${plan.channel} version (${formatVersion(highest.version)}) has been published since this plan was created`
    );
  }

  if (plan.channel === "alpha") {
    const highestStable = highestPublished(classified, "stable");
    if (highestStable && compareVersions(highestStable.version, planVersion) > 0) {
      reasons.push(
        `Stable ${formatVersion(highestStable.version)} is newer than ${plan.version}; publishing the alpha after it would hide it from alpha clients`
      );
    }
    if (!(await source.isAncestorOfMain(plan.sourceSha))) {
      reasons.push(`Source SHA ${plan.sourceSha} is not reachable from main on GitHub`);
    }
  } else if (plan.candidate) {
    const candidateSha = await source.tagSha(plan.candidate.tag);
    if (candidateSha !== plan.sourceSha) {
      reasons.push(
        `Candidate tag "${plan.candidate.tag}" now resolves to ${candidateSha ?? "(missing)"}, expected ${plan.sourceSha}`
      );
    }
  }

  return reasons.length === 0 ? { ok: true, resumeDraft } : { ok: false, reasons };
}
