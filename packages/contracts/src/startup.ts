export type MetadataStore = "sessions" | "settings";

export type MetadataIssueKind = "corrupt" | "invalid-shape" | "future-schema" | "missing" | "io";

export interface MetadataBackup {
  path: string;
  label: string;
  modifiedAt: number;
  valid: boolean;
  reason?: string;
}

export interface MetadataIssue {
  store: MetadataStore;
  file: string;
  kind: MetadataIssueKind;
  message: string;
  foundVersion?: number;
  supportedVersion: number;
  backups: MetadataBackup[];
}

export type StartupState = { mode: "ready" } | { mode: "recovery"; issues: MetadataIssue[]; dataDir: string };
