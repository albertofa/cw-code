import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BLOCK_MAP_SUFFIX, exists, readReleaseUpdateInfo, sha512Base64 } from "./rehash.ts";
import { tryParseVersion } from "./semver.ts";

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
