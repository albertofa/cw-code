import { statSync, type Stats } from "node:fs";
import type { MetadataIssueKind, MetadataStore } from "@cw-code/contracts";
import { readBytesIfExists, writeFileAtomic } from "./atomicFile.js";

export type MetadataDocument = Record<string, unknown>;
export type MetadataMigration = (raw: MetadataDocument) => MetadataDocument;

export interface MetadataSchema {
  kind: MetadataStore;
  currentVersion: number;
  validate: (raw: unknown) => string | null;
}

export interface VersionedJsonOptions extends MetadataSchema {
  filePath: string;
  migrations: Record<number, MetadataMigration>;
}

export type LoadResult =
  | { status: "missing" }
  | { status: "ok"; data: MetadataDocument; fromVersion: number; migrated: boolean };

const KIND_LABELS: Record<MetadataIssueKind, string> = {
  corrupt: "corrupt JSON",
  "invalid-shape": "unexpected data shape",
  "future-schema": "newer schema version",
  io: "file system error"
};

interface MetadataErrorInit {
  kind: MetadataIssueKind;
  file: string;
  store: MetadataStore;
  supportedVersion: number;
  detail: string;
  foundVersion?: number;
}

export class MetadataError extends Error {
  readonly kind: MetadataIssueKind;
  readonly file: string;
  readonly store: MetadataStore;
  readonly supportedVersion: number;
  readonly detail: string;
  readonly foundVersion?: number;

  constructor(init: MetadataErrorInit) {
    super(`${init.store} metadata at ${init.file}: ${KIND_LABELS[init.kind]}: ${init.detail}`);
    this.name = "MetadataError";
    this.kind = init.kind;
    this.file = init.file;
    this.store = init.store;
    this.supportedVersion = init.supportedVersion;
    this.detail = init.detail;
    if (init.foundVersion !== undefined) this.foundVersion = init.foundVersion;
  }

  get kindLabel(): string {
    return KIND_LABELS[this.kind];
  }
}

export function isMetadataDocument(value: unknown): value is MetadataDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseMetadataDocument(
  bytes: Uint8Array,
  schema: MetadataSchema,
  file: string
): { document: MetadataDocument; version: number } {
  const fail = (kind: MetadataIssueKind, detail: string, foundVersion?: number): MetadataError =>
    new MetadataError({ kind, file, store: schema.kind, supportedVersion: schema.currentVersion, detail, foundVersion });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw fail("corrupt", errorMessage(error));
  }
  if (!isMetadataDocument(parsed)) throw fail("invalid-shape", "the top-level value is not a JSON object");
  const version = parsed.schemaVersion ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw fail("invalid-shape", "schemaVersion must be a non-negative integer");
  }
  if (version > schema.currentVersion) {
    throw fail(
      "future-schema",
      `schema version ${version} was written by a newer cw-code; this version supports up to ${schema.currentVersion}`,
      version
    );
  }
  const problem = schema.validate(parsed);
  if (problem) throw fail("invalid-shape", problem, version);
  return { document: parsed, version };
}

export function migrationBackupPath(filePath: string, version: number): string {
  return `${filePath}.v${version}.bak`;
}

export function lastGoodBackupPath(filePath: string): string {
  return `${filePath}.last-good.bak`;
}

function ioError(opts: VersionedJsonOptions, detail: string, foundVersion?: number): MetadataError {
  return new MetadataError({
    kind: "io",
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
    if (!step) throw new Error(`no ${opts.kind} metadata migration from schema ${version}`);
    try {
      current = step(current);
    } catch (error) {
      throw new MetadataError({
        kind: "invalid-shape",
        file: opts.filePath,
        store: opts.kind,
        supportedVersion: opts.currentVersion,
        detail: `migration from schema ${version} failed: ${errorMessage(error)}`,
        foundVersion: fromVersion
      });
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

function ensureMigrationBackup(opts: VersionedJsonOptions, version: number, original: Buffer): void {
  const backupPath = migrationBackupPath(opts.filePath, version);
  try {
    const existing = statIfExists(backupPath);
    if (existing) {
      if (!existing.isFile()) throw new Error(`${backupPath} exists but is not a regular file`);
      return;
    }
    writeFileAtomic(backupPath, original);
    const readBack = readBytesIfExists(backupPath);
    if (!readBack || !readBack.equals(original)) throw new Error(`${backupPath} does not match the original bytes after writing`);
  } catch (error) {
    throw ioError(opts, `could not back up the schema ${version} file before migrating: ${errorMessage(error)}`, version);
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
    console.warn(`could not refresh ${backupPath}: ${errorMessage(error)}`);
  }
}

export function loadVersionedJson(opts: VersionedJsonOptions): LoadResult {
  let original: Buffer | null;
  try {
    original = readBytesIfExists(opts.filePath);
  } catch (error) {
    throw ioError(opts, `could not read the file: ${errorMessage(error)}`);
  }
  if (!original) return { status: "missing" };
  const { document, version } = parseMetadataDocument(original, opts, opts.filePath);
  const migrated = version < opts.currentVersion;
  let data = document;
  if (migrated) {
    data = applyMigrations(document, version, opts);
    const problem = opts.validate(data);
    if (problem) {
      throw new MetadataError({
        kind: "invalid-shape",
        file: opts.filePath,
        store: opts.kind,
        supportedVersion: opts.currentVersion,
        detail: `migrated data is invalid: ${problem}`,
        foundVersion: version
      });
    }
    ensureMigrationBackup(opts, version, original);
    try {
      writeFileAtomic(opts.filePath, JSON.stringify(data));
    } catch (error) {
      throw ioError(opts, `could not write the migrated file: ${errorMessage(error)}`, version);
    }
  }
  refreshLastGood(opts);
  return { status: "ok", data, fromVersion: version, migrated };
}
