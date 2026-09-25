import { buildReleaseNotes } from "./releaseNotes.ts";
import type { ReleaseSource } from "./releaseSource.ts";
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

export interface ReleasePlanCandidate {
  tag: string;
  sha: string;
}

export interface ReleasePlan {
  schema: 1;
  channel: "alpha" | "stable";
  version: string;
  tag: string;
  sourceSha: string;
  candidate?: ReleasePlanCandidate;
  previousTag: string | null;
  prerelease: boolean;
  makeLatest: boolean;
  notes: string;
  createdAt: string;
}

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
    latestAlphaPublishedAt: latestAlpha?.release.publishedAt ?? null
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
}

export async function buildStablePromotionPlan(options: BuildStablePlanOptions): Promise<PlanResult> {
  const { source, now, desktopVersion, candidateInput } = options;
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

  const resolution = resolveCandidate({ candidateInput, classified, tagShas, desktopBase });
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

export type VerifyPlanResult = { ok: true } | { ok: false; reasons: string[] };

export async function verifyPlan(plan: ReleasePlan, source: ReleaseSource): Promise<VerifyPlanResult> {
  const reasons: string[] = [];

  const existingTagSha = await source.tagSha(plan.tag);
  if (existingTagSha) {
    reasons.push(`Tag "${plan.tag}" already exists (points at ${existingTagSha})`);
  }

  const releases = await source.listReleases();
  const classified = classifyReleases(releases);
  const planVersion = parseVersion(plan.version);
  const highest = highestPublished(classified, plan.channel);
  if (highest && compareVersions(highest.version, planVersion) >= 0) {
    reasons.push(
      `A higher or equal ${plan.channel} version (${formatVersion(highest.version)}) has been published since this plan was created`
    );
  }

  if (plan.channel === "alpha") {
    const currentHead = await source.headSha();
    if (currentHead !== plan.sourceSha) {
      reasons.push(`Source SHA changed: plan expected ${plan.sourceSha}, HEAD is now ${currentHead}`);
    }
  } else if (plan.candidate) {
    const candidateSha = await source.tagSha(plan.candidate.tag);
    if (candidateSha !== plan.sourceSha) {
      reasons.push(
        `Candidate tag "${plan.candidate.tag}" now resolves to ${candidateSha ?? "(missing)"}, expected ${plan.sourceSha}`
      );
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
