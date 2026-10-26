import type { CliVersionCheck } from "./cli.js";
import type { DriverKind } from "./session.js";
import type { AppSettings } from "./settings.js";
import type { ShutdownAssessment, ShutdownStatus } from "./shutdown.js";
import type { SidebarOrderPrefs } from "./sidebar.js";

export interface HarnessIssue {
  id: "cli-binaries" | "cli-versions";
  level: "error" | "warning";
  title: string;
  message: string;
  binaries: DriverKind[];
}

export interface HarnessAvailability {
  checks: Array<CliVersionCheck & { skipped: boolean }>;
  installed: DriverKind[];
  issues: HarnessIssue[];
  checkedAt: number | null;
  trigger: "startup" | "settings" | "recheck";
  error: string | null;
}

export interface ComposerDraft {
  text: string;
  attachments: string[];
  updatedAt: number;
}

export type AppTopicData = {
  settings: AppSettings;
  home: { homeDir: string };
  harnesses: HarnessAvailability;
  attention: { count: number };
  shutdown: { status: ShutdownStatus; assessment: ShutdownAssessment };
  recentModels: Record<DriverKind, string[]>;
} & { [key: `draft/${string}`]: ComposerDraft };

export interface LegacyPreferences {
  sidebarOrder?: SidebarOrderPrefs;
  recentModels?: Partial<Record<DriverKind, string[]>>;
}
