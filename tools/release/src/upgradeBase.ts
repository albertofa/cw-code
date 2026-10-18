import { markedSourceSha } from "./planMarker.ts";
import type { ReleasePlan } from "./planValidation.ts";
import { ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME, STABLE_FEED_NAME, appImageNameFor, debNameFor, installerNameFor, linuxAssetNames } from "./releaseAssets.ts";
import type { RemoteRelease } from "./releaseClient.ts";
import { type ParsedVersion, compareVersions, formatVersion, parseTag, parseVersion } from "./semver.ts";

export type UpgradeBase =
  | { status: "found"; tag: string; version: string; installer: string }
  | { status: "bootstrap"; reason: string }
  | { status: "none-compatible"; reason: string };

export type LinuxUpgradeBase =
  | { status: "found"; tag: string; version: string; appImage: string; deb: string }
  | { status: "bootstrap" | "none-compatible"; reason: string };

type UpgradePlan = Pick<ReleasePlan, "version" | "channel">;

interface PipelineRelease {
  release: RemoteRelease;
  version: ParsedVersion;
}

function windowsAssetNames(version: string): string[] {
  return [installerNameFor(version), STABLE_FEED_NAME, ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME];
}

function pipelineRelease(release: RemoteRelease, requiredNames: (version: string) => string[]): PipelineRelease | null {
  const version = parseTag(release.tagName);
  if (!version || release.draft || markedSourceSha(release.body) === null) return null;
  const uploaded = new Set(release.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  return requiredNames(formatVersion(version)).every((name) => uploaded.has(name)) ? { release, version } : null;
}

function pipelineReleases(releases: RemoteRelease[], requiredNames: (version: string) => string[]): PipelineRelease[] {
  return releases.map((release) => pipelineRelease(release, requiredNames)).filter((entry): entry is PipelineRelease => entry !== null);
}

function highestCompatible(plan: UpgradePlan, pipeline: PipelineRelease[]): PipelineRelease | undefined {
  const candidate = parseVersion(plan.version);
  return pipeline
    .filter((entry) => compareVersions(entry.version, candidate) < 0)
    .filter((entry) => plan.channel === "stable" || entry.version.channel === "alpha")
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

function noneCompatibleReason(plan: UpgradePlan, carrying: string): string {
  return `no published ${plan.channel === "alpha" ? "alpha " : ""}release below ${plan.version} was produced by this pipeline${carrying}; an N -> N+1 upgrade cannot be exercised`;
}

export function selectUpgradeBase(plan: UpgradePlan, releases: RemoteRelease[]): UpgradeBase {
  const pipeline = pipelineReleases(releases, windowsAssetNames);
  if (pipeline.length === 0) {
    return { status: "bootstrap", reason: "no release published by this pipeline exists yet, so there is no updater-capable N to install" };
  }
  const best = highestCompatible(plan, pipeline);
  if (!best) return { status: "none-compatible", reason: noneCompatibleReason(plan, "") };
  const version = formatVersion(best.version);
  return { status: "found", tag: best.release.tagName, version, installer: installerNameFor(version) };
}

export function selectLinuxUpgradeBase(plan: UpgradePlan, releases: RemoteRelease[]): LinuxUpgradeBase {
  const pipeline = pipelineReleases(releases, linuxAssetNames);
  if (pipeline.length === 0) {
    return {
      status: "bootstrap",
      reason: "no release published by this pipeline carries the Linux AppImage, .deb and feeds yet, so there is no updater-capable Linux N to install"
    };
  }
  const best = highestCompatible(plan, pipeline);
  if (!best) return { status: "none-compatible", reason: noneCompatibleReason(plan, " with the Linux AppImage, .deb and feeds") };
  const version = formatVersion(best.version);
  return { status: "found", tag: best.release.tagName, version, appImage: appImageNameFor(version), deb: debNameFor(version) };
}
