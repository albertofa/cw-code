import type { DriverKind } from "./session.js";

export type HarnessInstallMethod = "native" | "npm" | "pnpm" | "bun" | "homebrew" | "winget" | "mise" | "unknown";

export type HarnessUpdatePhase = "idle" | "queued" | "running" | "succeeded" | "failed" | "unchanged";

export interface HarnessUpdateInfo {
  binary: DriverKind;
  status: "unknown" | "current" | "behind";
  currentVersion: string | null;
  latestVersion: string | null;
  installMethod: HarnessInstallMethod;
  canUpdate: boolean;
  /** Command that updates this install: shown for manual installs and as detail for one-click ones; null when there is none to suggest. */
  updateCommand: string | null;
  message: string | null;
  checkedAt: number | null;
  phase: HarnessUpdatePhase;
  phaseMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  output: string | null;
}

export type HarnessUpdates = Record<DriverKind, HarnessUpdateInfo>;
