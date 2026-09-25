import { constants, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readBytesIfExists, writeFileAtomic } from "./atomicFile.js";
import { describeError, parseMetadataDocument, type MetadataSchema } from "./metadataDocument.js";

export interface BackupInfo {
  path: string;
  label: string;
  modifiedAt: number;
  valid: boolean;
  reason?: string;
}

const LAST_GOOD_LABEL = "last good";
const MIGRATION_SUFFIX = /^(\d+)(?:\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?)?\.bak$/;

export function migrationBackupPath(filePath: string, version: number): string {
  return `${filePath}.v${version}.bak`;
}

export function lastGoodBackupPath(filePath: string): string {
  return `${filePath}.last-good.bak`;
}

export function beforeRepairBackupPath(filePath: string): string {
  return `${filePath}.before-repair.bak`;
}

export function timestampSuffix(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export function uniquePath(base: string, extension = ""): string {
  let candidate = `${base}${extension}`;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${base}-${n}${extension}`;
  return candidate;
}

export function backupLabel(file: string, name: string): string | null {
  const base = basename(file);
  if (name === `${base}.last-good.bak`) return LAST_GOOD_LABEL;
  const prefix = `${base}.v`;
  if (!name.startsWith(prefix)) return null;
  const match = MIGRATION_SUFFIX.exec(name.slice(prefix.length));
  return match ? `migration v${Number(match[1])}` : null;
}

export function inspectBackup(path: string, schema: MetadataSchema): { bytes: Buffer | null; reason: string | null } {
  try {
    if (!lstatSync(path).isFile()) return { bytes: null, reason: "not a regular file" };
    const bytes = readFileSync(path);
    parseMetadataDocument(bytes, schema, path);
    return { bytes, reason: null };
  } catch (error) {
    return { bytes: null, reason: describeError(error) };
  }
}

function backupNames(file: string): string[] {
  try {
    return readdirSync(dirname(file)).filter((name) => backupLabel(file, name) !== null);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export function hasBackupFiles(file: string): boolean {
  return backupNames(resolve(file)).length > 0;
}

function labelOrder(label: string): number {
  if (label === LAST_GOOD_LABEL) return Number.MAX_SAFE_INTEGER;
  return Number(label.replace(/^migration v/, ""));
}

export function listBackups(file: string, schema: MetadataSchema): BackupInfo[] {
  const resolved = resolve(file);
  const backups: BackupInfo[] = [];
  for (const name of backupNames(resolved)) {
    const label = backupLabel(resolved, name) ?? name;
    const path = join(dirname(resolved), name);
    let modifiedAt = 0;
    try {
      modifiedAt = lstatSync(path).mtimeMs;
    } catch (error) {
      backups.push({ path, label, modifiedAt, valid: false, reason: describeError(error) });
      continue;
    }
    const { reason } = inspectBackup(path, schema);
    backups.push(reason === null ? { path, label, modifiedAt, valid: true } : { path, label, modifiedAt, valid: false, reason });
  }
  return backups.sort((a, b) => labelOrder(b.label) - labelOrder(a.label) || b.modifiedAt - a.modifiedAt);
}

function assertSameBytes(path: string, expected: Uint8Array): void {
  const actual = readBytesIfExists(path);
  if (!actual || !actual.equals(expected)) throw new Error(`${path} does not match the original bytes after writing`);
}

export function writeVerified(path: string, bytes: Uint8Array): void {
  writeFileAtomic(path, bytes);
  assertSameBytes(path, bytes);
}

export function copyVerified(source: string, destination: string): void {
  const bytes = readFileSync(source);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  assertSameBytes(destination, bytes);
}
