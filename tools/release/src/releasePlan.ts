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

export const RECOVERY_RUNBOOK = "docs/operations/releases.md#recovery";

export interface DivergedTag {
  channel: "alpha" | "stable";
  tag: string;
  tagSha: string | null;
  sourceSha: string;
}

export class DivergedHistoryError extends Error {
  readonly diverged: DivergedTag[];

  constructor(diverged: DivergedTag[], problems: string[]) {
    super(`${problems.join("; ")}. See ${RECOVERY_RUNBOOK}`);
    this.diverged = diverged;
  }
}

async function divergedTags(source: ReleaseSource, classified: ClassifiedRelease[], sourceSha: string): Promise<DivergedTag[]> {
  const diverged: DivergedTag[] = [];
  for (const channel of ["alpha", "stable"] as const) {
    const latest = highestPublished(classified, channel);
    if (!latest) continue;
    const tag = latest.release.tagName;
    const tagSha = await source.tagSha(tag);
    if (!tagSha || !(await source.isAncestor(tagSha, sourceSha))) diverged.push({ channel, tag, tagSha, sourceSha });
  }
  return diverged;
}

function describeDivergence({ channel, tag, tagSha, sourceSha }: DivergedTag): string {
  return tagSha
    ? `Published ${channel} ${tag} (${tagSha}) is not an ancestor of ${sourceSha}`
    : `Published ${channel} ${tag} has no git tag, so ${sourceSha} cannot be proven to descend from it`;
}

export function acknowledgementProblems(diverged: DivergedTag[], acknowledged: readonly string[]): string[] {
  const divergedNames = new Set(diverged.map((entry) => entry.tag));
  const problems = diverged
    .filter((entry) => !acknowledged.includes(entry.tag))
    .map((entry) => `${describeDivergence(entry)}; an alpha is never built from older or unrelated history unless the operator acknowledges ${entry.tag} explicitly`);
  for (const tag of acknowledged) {
    if (!divergedNames.has(tag)) problems.push(`--acknowledge-diverged-tag names ${tag}, which has not diverged from the source commit`);
  }
  return problems;
}

export interface BuildAlphaPlanOptions {
  source: ReleaseSource;
  now: Date;
  desktopVersion: ParsedVersion;
  sha?: string;
  force?: boolean;
  acknowledgedDivergedTags?: readonly string[];
}

export async function buildAlphaPlan(options: BuildAlphaPlanOptions): Promise<PlanResult> {
  const { source, now, desktopVersion } = options;
  const releases = await source.listReleases();
  const classified = classifyReleases(releases);

  const nextAlpha = planNextAlpha(desktopVersion, classified, await source.listTags());
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
  const diverged = await divergedTags(source, classified, headSha);
  const problems = acknowledgementProblems(diverged, options.acknowledgedDivergedTags ?? []);
  if (problems.length > 0) throw new DivergedHistoryError(diverged, problems);
  const acknowledgedDivergedTags = diverged.map((entry) => entry.tag).sort();

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
      ...(acknowledgedDivergedTags.length > 0 ? { acknowledgedDivergedTags } : {}),
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

  const tag = tagOf(desktopBase);
  const existingTagSha = await source.tagSha(tag);
  if (existingTagSha) {
    throw new Error(`Tag ${tag} already exists in git (at ${existingTagSha}); a version is never reused, bump the base with set-base`);
  }
  const previousTag = highestStable?.release.tagName ?? null;
  const notes = buildReleaseNotes(await source.logSubjects(previousTag, resolution.candidate.sha));

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
    if (!(await source.isAncestor(plan.sourceSha, "main"))) {
      reasons.push(`Source SHA ${plan.sourceSha} is not reachable from main on GitHub`);
    }
    const recorded = plan.acknowledgedDivergedTags ?? [];
    for (const entry of await divergedTags(source, classified, plan.sourceSha)) {
      if (!recorded.includes(entry.tag)) reasons.push(`${describeDivergence(entry)}, and the plan did not acknowledge ${entry.tag}`);
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
