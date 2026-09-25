import { existsSync, lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { MetadataError, parseMetadataDocument, type MetadataSchema } from "./versionedJson.js";

export interface BackupInfo {
  path: string;
  label: string;
  modifiedAt: number;
  valid: boolean;
  reason?: string;
}

export interface RestoreResult {
  file: string;
  restoredFrom: string;
  brokenPath: string | null;
}

const LAST_GOOD_LABEL = "last good";
const MIGRATION_SUFFIX = /^(\d+)\.bak$/;

function backupLabel(file: string, name: string): string | null {
  const base = basename(file);
  if (name === `${base}.last-good.bak`) return LAST_GOOD_LABEL;
  const prefix = `${base}.v`;
  if (!name.startsWith(prefix)) return null;
  const match = MIGRATION_SUFFIX.exec(name.slice(prefix.length));
  return match ? `migration v${Number(match[1])}` : null;
}

function describeProblem(error: unknown): string {
  if (error instanceof MetadataError) return `${error.kindLabel}: ${error.detail}`;
  return error instanceof Error ? error.message : String(error);
}

function inspectBackup(path: string, schema: MetadataSchema): { bytes: Buffer | null; reason: string | null } {
  try {
    if (!lstatSync(path).isFile()) return { bytes: null, reason: "not a regular file" };
    const bytes = readFileSync(path);
    parseMetadataDocument(bytes, schema, path);
    return { bytes, reason: null };
  } catch (error) {
    return { bytes: null, reason: describeProblem(error) };
  }
}

function labelOrder(label: string): number {
  if (label === LAST_GOOD_LABEL) return Number.MAX_SAFE_INTEGER;
  return Number(label.replace(/^migration v/, ""));
}

export function listBackups(file: string, schema: MetadataSchema): BackupInfo[] {
  const resolved = resolve(file);
  const dir = dirname(resolved);
  const backups: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const label = backupLabel(resolved, name);
    if (!label) continue;
    const path = join(dir, name);
    let modifiedAt = 0;
    try {
      modifiedAt = lstatSync(path).mtimeMs;
    } catch (error) {
      backups.push({ path, label, modifiedAt, valid: false, reason: describeProblem(error) });
      continue;
    }
    const { reason } = inspectBackup(path, schema);
    backups.push(reason === null ? { path, label, modifiedAt, valid: true } : { path, label, modifiedAt, valid: false, reason });
  }
  return backups.sort((a, b) => labelOrder(b.label) - labelOrder(a.label));
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function brokenPathFor(file: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const base = `${file}.broken-${stamp}`;
  let candidate = base;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

export function restoreBackup(file: string, backupPath: string, schema: MetadataSchema, now: number = Date.now()): RestoreResult {
  const target = resolve(file);
  const source = resolve(backupPath);
  if (!samePath(dirname(source), dirname(target)) || backupLabel(target, basename(source)) === null) {
    throw new Error(`${backupPath} is not a backup of ${basename(target)}`);
  }
  const { bytes, reason } = inspectBackup(source, schema);
  if (!bytes) throw new Error(`backup ${basename(source)} cannot be restored: ${reason}`);
  const brokenPath = existsSync(target) ? brokenPathFor(target, now) : null;
  if (brokenPath) renameSync(target, brokenPath);
  try {
    writeFileAtomic(target, bytes);
  } catch (error) {
    if (brokenPath) renameSync(brokenPath, target);
    throw error;
  }
  return { file: target, restoredFrom: source, brokenPath };
}
