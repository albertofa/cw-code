import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type InstallerDigest, parseUpdateInfo, rewriteUpdateInfo } from "./updateInfoYaml.ts";

export const UPDATE_INFO_FILE_NAMES = ["latest.yml", "alpha.yml"] as const;
export const BLOCK_MAP_SUFFIX = ".blockmap";

export type BlockMapBuilder = (installerPath: string, blockMapPath: string) => Promise<InstallerDigest>;

export interface RehashedManifest {
  file: string;
  changed: boolean;
  previous: InstallerDigest;
}

export interface RehashResult {
  installer: string;
  blockMap: string;
  sha512: string;
  size: number;
  manifests: RehashedManifest[];
}

export interface ReleaseUpdateInfo {
  version: string;
  installerName: string;
  sha512: string;
  size: number;
  files: string[];
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha512Base64(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("base64");
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, contents, "utf8");
    await rename(temp, path);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function presentUpdateInfoFiles(dir: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of UPDATE_INFO_FILE_NAMES) {
    if (await exists(join(dir, name))) present.push(name);
  }
  if (present.length === 0) {
    throw new Error(`No update info file (${UPDATE_INFO_FILE_NAMES.join(", ")}) found in ${dir}`);
  }
  return present;
}

export async function readReleaseUpdateInfo(dir: string): Promise<ReleaseUpdateInfo> {
  const files = await presentUpdateInfoFiles(dir);
  const infos = await Promise.all(files.map(async (name) => ({ name, info: parseUpdateInfo(await readFile(join(dir, name), "utf8")) })));
  const [first] = infos;
  for (const { name, info } of infos) {
    if (info.version !== first.info.version || info.path !== first.info.path || info.sha512 !== first.info.sha512 || info.files[0].size !== first.info.files[0].size) {
      throw new Error(`${name} disagrees with ${first.name} about the version or installer (path, sha512 or size)`);
    }
    if (info.sha512 !== info.files[0].sha512) {
      throw new Error(`${name} top-level sha512 differs from files[0].sha512`);
    }
  }
  return { version: first.info.version, installerName: first.info.path, sha512: first.info.sha512, size: first.info.files[0].size, files };
}

export async function rehashRelease(dir: string, buildBlockMap: BlockMapBuilder): Promise<RehashResult> {
  const files = await presentUpdateInfoFiles(dir);
  const entries = await Promise.all(files.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })));
  const installerNames = new Set(entries.map(({ text }) => parseUpdateInfo(text).path));
  if (installerNames.size !== 1) {
    throw new Error(`Update info files reference different installers: ${[...installerNames].join(", ")}`);
  }
  const [installerName] = installerNames;
  const installer = join(dir, installerName);
  if (!(await exists(installer))) {
    throw new Error(`Installer "${installerName}" referenced by ${files.join(", ")} does not exist in ${dir}`);
  }

  const blockMap = `${installer}${BLOCK_MAP_SUFFIX}`;
  const built = await buildBlockMap(installer, blockMap);
  const [actualSha512, actualStat] = await Promise.all([sha512Base64(installer), stat(installer)]);
  if (built.sha512 !== actualSha512 || built.size !== actualStat.size) {
    throw new Error(
      `Blockmap builder reported sha512/size that do not match ${installerName} on disk (reported ${built.size} bytes, actual ${actualStat.size})`
    );
  }
  if (!(await exists(blockMap))) {
    throw new Error(`Blockmap builder did not write ${basename(blockMap)}`);
  }

  const manifests: RehashedManifest[] = [];
  for (const { name, text } of entries) {
    const rewrite = rewriteUpdateInfo(text, { sha512: actualSha512, size: actualStat.size });
    if (rewrite.changed) await writeFileAtomic(join(dir, name), rewrite.text);
    manifests.push({ file: name, changed: rewrite.changed, previous: rewrite.previous });
  }

  return { installer: installerName, blockMap: basename(blockMap), sha512: actualSha512, size: actualStat.size, manifests };
}
