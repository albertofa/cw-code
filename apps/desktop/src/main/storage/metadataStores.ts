import type { MetadataIssue, MetadataStore } from "@cw-code/contracts";
import { SESSION_METADATA, SessionStore } from "../sessions/SessionStore.js";
import { SETTINGS_METADATA, SettingsStore } from "../settings/SettingsStore.js";
import { listBackups, type BackupInfo } from "./recovery.js";
import { MetadataError, type MetadataSchema } from "./versionedJson.js";

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
    console.warn(`could not list backups for ${error.file}: ${(listError as Error).message}`);
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

function open<T>(create: () => T, issues: MetadataIssue[]): T | null {
  try {
    return create();
  } catch (error) {
    if (!(error instanceof MetadataError)) throw error;
    issues.push(metadataIssue(error));
    return null;
  }
}

export function openMetadataStores(paths: { dbPath: string; settingsPath: string }): OpenedMetadataStores {
  const issues: MetadataIssue[] = [];
  const settingsStore = open(() => new SettingsStore(paths.settingsPath), issues);
  const sessionStore = open(() => new SessionStore(paths.dbPath), issues);
  if (!sessionStore || !settingsStore) return { ok: false, issues };
  return { ok: true, sessionStore, settingsStore };
}
