import type { MetadataIssue, MetadataStore } from "@cw-code/contracts";
import { SESSION_METADATA, SessionStore, sessionStoreFile } from "../sessions/SessionStore.js";
import { SETTINGS_METADATA, SettingsStore } from "../settings/SettingsStore.js";
import { listBackups, type BackupInfo } from "./backups.js";
import { describeError, MetadataError, type MetadataSchema } from "./metadataDocument.js";

export type OpenedMetadataStores =
  | { ok: true; sessionStore: SessionStore; settingsStore: SettingsStore }
  | { ok: false; issues: MetadataIssue[] };

export function metadataSchemaFor(store: MetadataStore): MetadataSchema {
  return store === "sessions" ? SESSION_METADATA : SETTINGS_METADATA;
}

function backupsFor(error: MetadataError): BackupInfo[] {
  try {
    return listBackups(error.file, metadataSchemaFor(error.store));
  } catch (listError) {
    console.warn(`could not list backups for ${error.file}: ${describeError(listError)}`);
    return [];
  }
}

export function metadataIssue(error: MetadataError): MetadataIssue {
  return {
    store: error.store,
    file: error.file,
    kind: error.kind,
    message: error.detail,
    ...(error.foundVersion !== undefined ? { foundVersion: error.foundVersion } : {}),
    supportedVersion: error.supportedVersion,
    backups: backupsFor(error)
  };
}

function asMetadataError(error: unknown, store: MetadataStore, file: string): MetadataError {
  if (error instanceof MetadataError) return error;
  return new MetadataError({
    kind: "io",
    file,
    store,
    supportedVersion: metadataSchemaFor(store).currentVersion,
    detail: `could not open the file: ${describeError(error)}`
  });
}

function open<T>(store: MetadataStore, file: string, create: () => T, issues: MetadataIssue[]): T | null {
  try {
    return create();
  } catch (error) {
    issues.push(metadataIssue(asMetadataError(error, store, file)));
    return null;
  }
}

export function openMetadataStores(paths: { dbPath: string; settingsPath: string }): OpenedMetadataStores {
  const issues: MetadataIssue[] = [];
  const settingsStore = open("settings", paths.settingsPath, () => new SettingsStore(paths.settingsPath), issues);
  const sessionStore = open("sessions", sessionStoreFile(paths.dbPath), () => new SessionStore(paths.dbPath), issues);
  if (!sessionStore || !settingsStore) return { ok: false, issues };
  return { ok: true, sessionStore, settingsStore };
}
