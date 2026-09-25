import { readFile, writeFile } from "node:fs/promises";
import { parseVersion } from "./semver.ts";

export const DEFAULT_PACKAGE_RELATIVE_PATHS = ["package.json", "apps/desktop/package.json", "packages/contracts/package.json"];

export interface PackageVersionEntry {
  path: string;
  version: string;
}

export interface SyncResult {
  inSync: boolean;
  entries: PackageVersionEntry[];
  version: string | null;
}

async function readVersion(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`"${path}" has no string "version" field`);
  }
  return parsed.version;
}

export async function readPackageVersions(paths: string[]): Promise<PackageVersionEntry[]> {
  const entries: PackageVersionEntry[] = [];
  for (const path of paths) {
    entries.push({ path, version: await readVersion(path) });
  }
  return entries;
}

export async function checkSync(paths: string[]): Promise<SyncResult> {
  const entries = await readPackageVersions(paths);
  const distinct = new Set(entries.map((entry) => entry.version));
  const inSync = distinct.size <= 1;
  return { inSync, entries, version: inSync ? (entries[0]?.version ?? null) : null };
}

async function writeVersion(path: string, version: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.version = version;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function applyVersion(paths: string[], version: string): Promise<void> {
  parseVersion(version);
  for (const path of paths) {
    await writeVersion(path, version);
  }
}

export async function setBase(paths: string[], base: string): Promise<void> {
  const parsed = parseVersion(base);
  if (parsed.channel !== "stable") {
    throw new Error(`set-base requires a stable "X.Y.Z" version, got "${base}"`);
  }
  for (const path of paths) {
    await writeVersion(path, base);
  }
}
