import type { MetadataIssueKind, MetadataStore } from "@cw-code/contracts";

export type MetadataDocument = Record<string, unknown>;
export type MetadataMigration = (raw: MetadataDocument) => MetadataDocument;

export interface MetadataSchema {
  kind: MetadataStore;
  currentVersion: number;
  validate: (raw: unknown) => string | null;
  empty: () => MetadataDocument;
}

const KIND_LABELS: Record<MetadataIssueKind, string> = {
  corrupt: "corrupt JSON",
  "invalid-shape": "unexpected data shape",
  "future-schema": "newer schema version",
  missing: "file missing",
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

export function describeError(error: unknown): string {
  if (error instanceof MetadataError) return `${error.kindLabel}: ${error.detail}`;
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.startsWith(code) ? `${code}: ${error.message}` : error.message;
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
    throw fail("corrupt", describeError(error));
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
