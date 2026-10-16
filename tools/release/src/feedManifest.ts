import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BLOCK_MAP_SUFFIX, exists, readReleaseUpdateInfo, sha512Base64 } from "./rehash.ts";
import {
  LINUX_ALPHA_FEED_NAME,
  LINUX_STABLE_FEED_NAME,
  type ReleaseAssetFile,
  appImageNameFor,
  debNameFor,
  describeFile,
  linuxFeedFileErrors
} from "./releaseAssets.ts";
import { tryParseVersion } from "./semver.ts";
import { parseUpdateInfo } from "./updateInfoYaml.ts";

export interface FeedExpectations {
  version?: string;
  channelFiles?: readonly string[];
  requireBlockMap?: boolean;
}

export interface FeedManifestReport {
  dir: string;
  version: string | null;
  installer: string | null;
  channelFiles: string[];
  sizeBytes: number | null;
  blockMap: boolean;
  errors: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateReleaseFeed(dir: string, expectations: FeedExpectations = {}): Promise<FeedManifestReport> {
  const report: FeedManifestReport = { dir, version: null, installer: null, channelFiles: [], sizeBytes: null, blockMap: false, errors: [] };
  let info: Awaited<ReturnType<typeof readReleaseUpdateInfo>>;
  try {
    info = await readReleaseUpdateInfo(dir);
  } catch (error: unknown) {
    report.errors.push(message(error));
    return report;
  }
  report.version = info.version;
  report.installer = info.installerName;
  report.channelFiles = info.files;

  const parsed = tryParseVersion(info.version);
  if (!parsed) report.errors.push(`version ${info.version} is neither X.Y.Z nor X.Y.Z-alpha.N, so cw-code would ignore it`);
  if (parsed?.channel === "alpha" && !info.files.includes("alpha.yml")) report.errors.push(`alpha version ${info.version} has no alpha.yml`);
  if (parsed?.channel === "stable" && !info.files.includes("latest.yml")) report.errors.push(`stable version ${info.version} has no latest.yml`);
  if (expectations.version !== undefined && info.version !== expectations.version) {
    report.errors.push(`update info version is ${info.version}, expected ${expectations.version}`);
  }
  for (const file of expectations.channelFiles ?? []) {
    if (!info.files.includes(file)) report.errors.push(`${file} is missing`);
  }

  const installer = join(dir, info.installerName);
  if (!(await exists(installer))) {
    report.errors.push(`installer ${info.installerName} referenced by ${info.files.join(", ")} does not exist`);
    return report;
  }
  const size = (await stat(installer)).size;
  report.sizeBytes = size;
  if (size !== info.size) report.errors.push(`installer is ${size} bytes but the update info says ${info.size}`);
  if ((await sha512Base64(installer)) !== info.sha512) report.errors.push(`installer sha512 does not match the update info`);
  report.blockMap = await exists(`${installer}${BLOCK_MAP_SUFFIX}`);
  if (expectations.requireBlockMap && !report.blockMap) report.errors.push(`${info.installerName}${BLOCK_MAP_SUFFIX} is missing`);
  return report;
}

export interface LinuxFeedReport {
  dir: string;
  version: string | null;
  channelFiles: string[];
  appImage: ReleaseAssetFile | null;
  deb: ReleaseAssetFile | null;
  errors: string[];
}

export async function validateLinuxReleaseFeed(dir: string): Promise<LinuxFeedReport> {
  const report: LinuxFeedReport = { dir, version: null, channelFiles: [], appImage: null, deb: null, errors: [] };
  const latestPath = join(dir, LINUX_STABLE_FEED_NAME);
  if (!(await exists(latestPath))) {
    report.errors.push(`${LINUX_STABLE_FEED_NAME} is missing from ${dir}`);
    return report;
  }
  const latest = await readFile(latestPath);
  let info: ReturnType<typeof parseUpdateInfo>;
  try {
    info = parseUpdateInfo(latest.toString("utf8"));
  } catch (error: unknown) {
    report.errors.push(`${LINUX_STABLE_FEED_NAME}: ${message(error)}`);
    return report;
  }
  report.version = info.version;
  report.channelFiles.push(LINUX_STABLE_FEED_NAME);
  const parsed = tryParseVersion(info.version);
  if (!parsed) report.errors.push(`version ${info.version} is neither X.Y.Z nor X.Y.Z-alpha.N, so cw-code would ignore it`);
  if (await exists(join(dir, LINUX_ALPHA_FEED_NAME))) {
    report.channelFiles.push(LINUX_ALPHA_FEED_NAME);
    if (!latest.equals(await readFile(join(dir, LINUX_ALPHA_FEED_NAME)))) {
      report.errors.push(`${LINUX_ALPHA_FEED_NAME} must be a byte copy of ${LINUX_STABLE_FEED_NAME}`);
    }
  } else if (parsed?.channel === "alpha") {
    report.errors.push(`alpha version ${info.version} has no ${LINUX_ALPHA_FEED_NAME}`);
  }
  const describe = async (name: string): Promise<ReleaseAssetFile | null> => {
    if (await exists(join(dir, name))) return describeFile(dir, name);
    report.errors.push(`${name} referenced by ${LINUX_STABLE_FEED_NAME} does not exist`);
    return null;
  };
  report.appImage = await describe(appImageNameFor(info.version));
  report.deb = await describe(debNameFor(info.version));
  report.errors.push(...linuxFeedFileErrors(info, info.version, report.appImage ?? undefined, report.deb ?? undefined));
  return report;
}
