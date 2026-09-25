import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { archivedLastGoodPath, backupLabel, copyVerified, inspectBackup, lastGoodBackupPath, timestampSuffix, uniquePath } from "./backups.js";
import type { MetadataSchema } from "./metadataDocument.js";

export interface RestoreResult {
  file: string;
  restoredFrom: string;
  brokenPath: string | null;
  archivedLastGood: string | null;
}

export interface StartFreshResult {
  file: string;
  brokenPath: string | null;
  archivedLastGood: string | null;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function preserveCurrent(target: string, now: number): string | null {
  if (!existsSync(target)) return null;
  const brokenPath = uniquePath(`${target}.broken-${timestampSuffix(now)}`);
  copyVerified(target, brokenPath);
  return brokenPath;
}

function archiveLastGood(target: string, now: number): string | null {
  const lastGood = lastGoodBackupPath(target);
  if (!existsSync(lastGood) || !lstatSync(lastGood).isFile()) return null;
  const archived = archivedLastGoodPath(target, now);
  copyVerified(lastGood, archived);
  return archived;
}

export function restoreBackup(file: string, backupPath: string, schema: MetadataSchema, now: number = Date.now()): RestoreResult {
  const target = resolve(file);
  const source = resolve(backupPath);
  if (!samePath(dirname(source), dirname(target)) || backupLabel(target, basename(source)) === null) {
    throw new Error(`${backupPath} is not a backup of ${basename(target)}`);
  }
  const { bytes, reason } = inspectBackup(source, schema);
  if (!bytes) throw new Error(`backup ${basename(source)} cannot be restored: ${reason}`);
  const brokenPath = preserveCurrent(target, now);
  const archivedLastGood = archiveLastGood(target, now);
  writeFileAtomic(target, bytes);
  return { file: target, restoredFrom: source, brokenPath, archivedLastGood };
}

export function startFresh(file: string, schema: MetadataSchema, now: number = Date.now()): StartFreshResult {
  const target = resolve(file);
  const brokenPath = preserveCurrent(target, now);
  const archivedLastGood = archiveLastGood(target, now);
  writeFileAtomic(target, JSON.stringify(schema.empty()));
  return { file: target, brokenPath, archivedLastGood };
}
