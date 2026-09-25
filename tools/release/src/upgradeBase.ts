import { markedSourceSha } from "./planMarker.ts";
import type { ReleasePlan } from "./planValidation.ts";
import { ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME, STABLE_FEED_NAME, installerNameFor } from "./releaseAssets.ts";
import type { RemoteRelease } from "./releaseClient.ts";
import { type ParsedVersion, compareVersions, formatVersion, parseTag, parseVersion } from "./semver.ts";

export type UpgradeBase =
  | { status: "found"; tag: string; version: string; installer: string }
  | { status: "bootstrap"; reason: string }
  | { status: "none-compatible"; reason: string };

interface PipelineRelease {
  release: RemoteRelease;
  version: ParsedVersion;
}

function pipelineRelease(release: RemoteRelease): PipelineRelease | null {
  const version = parseTag(release.tagName);
  if (!version || release.draft || markedSourceSha(release.body) === null) return null;
  const uploaded = new Set(release.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  const required = [installerNameFor(formatVersion(version)), STABLE_FEED_NAME, ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME];
  return required.every((name) => uploaded.has(name)) ? { release, version } : null;
}

export function selectUpgradeBase(plan: Pick<ReleasePlan, "version" | "channel">, releases: RemoteRelease[]): UpgradeBase {
  const candidate = parseVersion(plan.version);
  const pipeline = releases.map(pipelineRelease).filter((entry): entry is PipelineRelease => entry !== null);
  if (pipeline.length === 0) {
    return { status: "bootstrap", reason: "no release published by this pipeline exists yet, so there is no updater-capable N to install" };
  }
  const compatible = pipeline
    .filter((entry) => compareVersions(entry.version, candidate) < 0)
    .filter((entry) => plan.channel === "stable" || entry.version.channel === "alpha")
    .sort((a, b) => compareVersions(b.version, a.version));
  const [best] = compatible;
  if (!best) {
    return {
      status: "none-compatible",
      reason: `no published ${plan.channel === "alpha" ? "alpha " : ""}release below ${plan.version} was produced by this pipeline; an N -> N+1 upgrade cannot be exercised`
    };
  }
  const version = formatVersion(best.version);
  return { status: "found", tag: best.release.tagName, version, installer: installerNameFor(version) };
}
