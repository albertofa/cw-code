import { readdirSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readBytesIfExists, writeFileAtomic } from "./atomicFile.js";
import {
  backupLabel,
  lastGoodBackupPath,
  listBackups,
  metadataArtifactNames,
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

function refreshLastGood(filePath: string): void {
  const backupPath = lastGoodBackupPath(filePath);
  try {
    const current = readBytesIfExists(filePath);
    if (!current) return;
    const existing = readBytesIfExists(backupPath);
    if (existing?.equals(current)) return;
    writeFileAtomic(backupPath, current);
  } catch (error) {
    console.warn(`could not refresh ${backupPath}: ${describeError(error)}`);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function missingResult(opts: VersionedJsonOptions): LoadResult {
  let restorable: number;
  let artifacts: string[];
  try {
    restorable = listBackups(opts.filePath, opts).filter((backup) => backup.valid).length;
    artifacts = metadataArtifactNames(opts.filePath);
  } catch (error) {
    throw metadataError(opts, "io", `the file is missing and its backups could not be checked: ${describeError(error)}`);
  }
  const name = basename(opts.filePath);
  if (restorable > 0) {
    throw metadataError(opts, "missing", `${name} is missing but ${plural(restorable, "restorable backup")} of it exist${restorable === 1 ? "s" : ""}`);
  }
  if (artifacts.length > 0) {
    throw metadataError(
      opts,
      "missing",
      `${name} is missing and none of its backups can be restored, but ${plural(artifacts.length, "cw-code file")} for it remain: ${artifacts.join(", ")}`
    );
  }
  return { status: "missing" };
}

export const LAST_GOOD_REFRESH_INTERVAL_MS = 60_000;

export class LastGoodRefresher {
  private lastRefreshAt: number;
  private pending = false;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {
    this.lastRefreshAt = now();
  }

  afterPersist(): void {
    const now = this.now();
    if (now - this.lastRefreshAt < LAST_GOOD_REFRESH_INTERVAL_MS) {
      this.pending = true;
      return;
    }
    this.refresh(now);
  }

  flush(): void {
    if (this.pending) this.refresh(this.now());
  }

  private refresh(now: number): void {
    this.pending = false;
    this.lastRefreshAt = now;
    refreshLastGood(this.filePath);
  }
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
  refreshLastGood(opts.filePath);
  return { status: "ok", data, fromVersion: version, migrated };
}
