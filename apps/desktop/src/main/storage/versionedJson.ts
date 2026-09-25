import { readdirSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readBytesIfExists, writeFileAtomic } from "./atomicFile.js";
import {
  backupLabel,
  lastGoodBackupPath,
  listBackups,
  migrationBackupPath,
  timestampSuffix,
  uniquePath,
  writeVerified
} from "./backups.js";
import {
  describeError,
  MetadataError,
  parseMetadataDocument,
  type MetadataDocument,
  type MetadataMigration,
  type MetadataSchema
} from "./metadataDocument.js";

export interface VersionedJsonOptions extends MetadataSchema {
  filePath: string;
  migrations: Record<number, MetadataMigration>;
  now?: () => number;
}

export type LoadResult =
  | { status: "missing" }
  | { status: "ok"; data: MetadataDocument; fromVersion: number; migrated: boolean };

function metadataError(
  opts: VersionedJsonOptions,
  kind: MetadataError["kind"],
  detail: string,
  foundVersion?: number
): MetadataError {
  return new MetadataError({
    kind,
    file: opts.filePath,
    store: opts.kind,
    supportedVersion: opts.currentVersion,
    detail,
    foundVersion
  });
}

function applyMigrations(document: MetadataDocument, fromVersion: number, opts: VersionedJsonOptions): MetadataDocument {
  let current = structuredClone(document);
  for (let version = fromVersion; version < opts.currentVersion; version += 1) {
    const step = opts.migrations[version];
    if (!step) throw metadataError(opts, "io", `cw-code has no migration from schema ${version}`, fromVersion);
    try {
      current = step(current);
    } catch (error) {
      throw metadataError(opts, "invalid-shape", `migration from schema ${version} failed: ${describeError(error)}`, fromVersion);
    }
  }
  const rest = { ...current };
  delete rest.schemaVersion;
  return { schemaVersion: opts.currentVersion, ...rest };
}

function statIfExists(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hasMatchingMigrationBackup(filePath: string, version: number, original: Buffer): boolean {
  const label = `migration v${version}`;
  return readdirSync(dirname(filePath))
    .filter((name) => backupLabel(filePath, name) === label)
    .some((name) => readBytesIfExists(join(dirname(filePath), name))?.equals(original) === true);
}

function ensureMigrationBackup(opts: VersionedJsonOptions, version: number, original: Buffer): void {
  const backupPath = migrationBackupPath(opts.filePath, version);
  try {
    const existing = statIfExists(backupPath);
    if (existing && !existing.isFile()) throw new Error(`${backupPath} exists but is not a regular file`);
    if (!existing) {
      writeVerified(backupPath, original);
      return;
    }
    if (hasMatchingMigrationBackup(opts.filePath, version, original)) return;
    const now = opts.now?.() ?? Date.now();
    writeVerified(uniquePath(`${opts.filePath}.v${version}.${timestampSuffix(now)}`, ".bak"), original);
  } catch (error) {
    throw metadataError(opts, "io", `could not back up the schema ${version} file before migrating: ${describeError(error)}`, version);
  }
}

function refreshLastGood(opts: VersionedJsonOptions): void {
  const backupPath = lastGoodBackupPath(opts.filePath);
  try {
    const current = readBytesIfExists(opts.filePath);
    if (!current) return;
    const existing = readBytesIfExists(backupPath);
    if (existing?.equals(current)) return;
    writeFileAtomic(backupPath, current);
  } catch (error) {
    console.warn(`could not refresh ${backupPath}: ${describeError(error)}`);
  }
}

function missingResult(opts: VersionedJsonOptions): LoadResult {
  let restorable: number;
  try {
    restorable = listBackups(opts.filePath, opts).filter((backup) => backup.valid).length;
  } catch (error) {
    throw metadataError(opts, "io", `the file is missing and its backups could not be checked: ${describeError(error)}`);
  }
  if (restorable > 0) {
    throw metadataError(
      opts,
      "missing",
      `${basename(opts.filePath)} is missing but ${restorable} restorable backup${restorable === 1 ? "" : "s"} of it exist${restorable === 1 ? "s" : ""}`
    );
  }
  return { status: "missing" };
}

export function loadVersionedJson(opts: VersionedJsonOptions): LoadResult {
  let original: Buffer | null;
  try {
    original = readBytesIfExists(opts.filePath);
  } catch (error) {
    throw metadataError(opts, "io", `could not read the file: ${describeError(error)}`);
  }
  if (!original) return missingResult(opts);
  const { document, version } = parseMetadataDocument(original, opts, opts.filePath);
  const migrated = version < opts.currentVersion;
  let data = document;
  if (migrated) {
    data = applyMigrations(document, version, opts);
    const problem = opts.validate(data);
    if (problem) throw metadataError(opts, "invalid-shape", `migrated data is invalid: ${problem}`, version);
    ensureMigrationBackup(opts, version, original);
    try {
      writeFileAtomic(opts.filePath, JSON.stringify(data));
    } catch (error) {
      throw metadataError(opts, "io", `could not write the migrated file: ${describeError(error)}`, version);
    }
  }
  refreshLastGood(opts);
  return { status: "ok", data, fromVersion: version, migrated };
}
