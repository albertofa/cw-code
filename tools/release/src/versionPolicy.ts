import type { ReleaseInfo } from "./releaseSource.ts";
import {
  type AlphaVersion,
  type ParsedVersion,
  type StableVersion,
  FULL_SHA_PATTERN,
  baseOf,
  compareVersions,
  formatVersion,
  parseTag,
  sameBase
} from "./semver.ts";

export interface ClassifiedRelease {
  release: ReleaseInfo;
  version: ParsedVersion;
}

export function classifyReleases(releases: ReleaseInfo[]): ClassifiedRelease[] {
  const classified: ClassifiedRelease[] = [];
  for (const release of releases) {
    const version = parseTag(release.tagName);
    if (version) classified.push({ release, version });
  }
  return classified;
}

export function highestPublished(
  classified: ClassifiedRelease[],
  channel: "stable" | "alpha"
): ClassifiedRelease | null {
  let best: ClassifiedRelease | null = null;
  for (const entry of classified) {
    if (entry.release.draft) continue;
    if (entry.version.channel !== channel) continue;
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}

export function nextAlphaNumberForBase(classified: ClassifiedRelease[], base: StableVersion, usedTags: readonly string[] = []): number {
  const used = [...classified.map((entry) => entry.version), ...usedTags.map(parseTag).filter((version): version is ParsedVersion => version !== null)];
  let max = -1;
  for (const version of used) {
    if (version.channel !== "alpha") continue;
    if (!sameBase(version, base)) continue;
    if (version.alphaNumber > max) max = version.alphaNumber;
  }
  return max + 1;
}

export type NextAlphaResult = { ok: true; version: AlphaVersion } | { ok: false; reason: string };

export function planNextAlpha(desktopVersion: ParsedVersion, classified: ClassifiedRelease[], usedTags: readonly string[] = []): NextAlphaResult {
  const base = baseOf(desktopVersion);
  const publishedStable = highestPublished(classified, "stable");
  if (publishedStable && compareVersions(publishedStable.version, base) >= 0) {
    return {
      ok: false,
      reason: `Base ${formatVersion(base)} is already published as stable (${formatVersion(publishedStable.version)}); bump the base version via a normal PR first`
    };
  }
  const publishedAlpha = highestPublished(classified, "alpha");
  if (publishedAlpha) {
    const alphaBase = baseOf(publishedAlpha.version);
    if (compareVersions(base, alphaBase) < 0) {
      return {
        ok: false,
        reason: `Base ${formatVersion(base)} is behind the highest published alpha base ${formatVersion(alphaBase)}; the desktop version must never move backwards`
      };
    }
  }
  const alphaNumber = nextAlphaNumberForBase(classified, base, usedTags);
  return {
    ok: true,
    version: { channel: "alpha", major: base.major, minor: base.minor, patch: base.patch, alphaNumber }
  };
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export interface AlphaThrottleInput {
  now: Date;
  headSha: string;
  latestChangeSha: string | null;
  latestAlphaPublishedAt: string | null;
  force?: boolean;
}

export type AlphaThrottleResult = { skip: true; reason: string } | { skip: false };

export function shouldSkipAutomaticAlpha(input: AlphaThrottleInput): AlphaThrottleResult {
  if (input.latestChangeSha && input.latestChangeSha === input.headSha) {
    return { skip: true, reason: `HEAD (${input.headSha}) matches the latest published release; nothing changed since then` };
  }
  if (!input.force && input.latestAlphaPublishedAt) {
    const elapsedMs = input.now.getTime() - new Date(input.latestAlphaPublishedAt).getTime();
    if (elapsedMs < SIX_HOURS_MS) {
      const remainingMinutes = Math.ceil((SIX_HOURS_MS - elapsedMs) / 60_000);
      return {
        skip: true,
        reason: `Last alpha was published ${Math.round(elapsedMs / 60_000)} minute(s) ago; wait ${remainingMinutes} more minute(s) to respect the 6-hour coalescing window`
      };
    }
  }
  return { skip: false };
}

export interface CandidateResolution {
  release: ReleaseInfo;
  version: AlphaVersion;
  sha: string;
}

export type CandidateResolutionResult = { ok: true; candidate: CandidateResolution } | { ok: false; reason: string };

export function resolveCandidate(input: {
  candidateInput: string;
  classified: ClassifiedRelease[];
  tagShas: Map<string, string>;
  desktopBase: StableVersion;
  expectedSha?: string;
}): CandidateResolutionResult {
  const { candidateInput, classified, tagShas, desktopBase, expectedSha } = input;

  const byTag = classified.find((entry) => entry.release.tagName === candidateInput);
  let matched = byTag ?? null;

  if (!matched && FULL_SHA_PATTERN.test(candidateInput)) {
    const shaInput = candidateInput.toLowerCase();
    const matches = classified.filter(
      (entry) => entry.version.channel === "alpha" && tagShas.get(entry.release.tagName)?.toLowerCase() === shaInput
    );
    if (matches.length > 1) {
      const tags = matches.map((entry) => entry.release.tagName).join(", ");
      return {
        ok: false,
        reason: `Candidate SHA "${candidateInput}" matches multiple published alpha tags (${tags}); specify the tag explicitly`
      };
    }
    matched = matches[0] ?? null;
  }

  if (!matched) {
    return {
      ok: false,
      reason: `Candidate "${candidateInput}" does not match any published release tag or its resolved commit SHA`
    };
  }

  if (matched.release.draft) {
    return { ok: false, reason: `Candidate "${matched.release.tagName}" is a draft release, not published` };
  }

  if (matched.version.channel !== "alpha") {
    return { ok: false, reason: `Candidate "${matched.release.tagName}" is not an alpha release` };
  }

  if (!sameBase(matched.version, desktopBase)) {
    return {
      ok: false,
      reason: `Candidate base ${formatVersion(baseOf(matched.version))} does not match the intended stable base ${formatVersion(desktopBase)}`
    };
  }

  const sha = tagShas.get(matched.release.tagName);
  if (!sha) {
    return { ok: false, reason: `Candidate tag "${matched.release.tagName}" does not exist in git (missing tag)` };
  }

  if (expectedSha && sha.toLowerCase() !== expectedSha.toLowerCase()) {
    return {
      ok: false,
      reason: `Candidate tag "${matched.release.tagName}" resolves to ${sha}, which does not match --expected-sha ${expectedSha}`
    };
  }

  return { ok: true, candidate: { release: matched.release, version: matched.version, sha } };
}

export function validateCandidateIsNewerThanStable(
  candidateVersion: AlphaVersion,
  highestStable: ClassifiedRelease | null
): { ok: true } | { ok: false; reason: string } {
  if (!highestStable) return { ok: true };
  if (compareVersions(candidateVersion, highestStable.version) > 0) return { ok: true };
  return {
    ok: false,
    reason: `Stable release ${formatVersion(highestStable.version)} already supersedes candidate base ${formatVersion(baseOf(candidateVersion))}`
  };
}
