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

async function writeVersionToAll(paths: string[], version: string): Promise<void> {
  const staged: Array<{ path: string; original: string; updated: string }> = [];
  for (const path of paths) {
    const original = await readFile(path, "utf8");
    const parsed = JSON.parse(original) as Record<string, unknown>;
    parsed.version = version;
    staged.push({ path, original, updated: `${JSON.stringify(parsed, null, 2)}\n` });
  }
  const written: typeof staged = [];
  try {
    for (const entry of staged) {
      await writeFile(entry.path, entry.updated, "utf8");
      written.push(entry);
    }
  } catch (error) {
    const restoreFailures: string[] = [];
    for (const entry of written) {
      try {
        await writeFile(entry.path, entry.original, "utf8");
      } catch {
        restoreFailures.push(entry.path);
      }
    }
    const suffix = restoreFailures.length > 0 ? `; could not restore ${restoreFailures.join(", ")}` : "; earlier files were restored";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}

export async function applyVersion(paths: string[], version: string): Promise<void> {
  parseVersion(version);
  await writeVersionToAll(paths, version);
}

export async function setBase(paths: string[], base: string): Promise<void> {
  const parsed = parseVersion(base);
  if (parsed.channel !== "stable") {
    throw new Error(`set-base requires a stable "X.Y.Z" version, got "${base}"`);
  }
  await writeVersionToAll(paths, base);
}
