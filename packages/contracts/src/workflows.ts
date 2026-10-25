import type { WorkflowSubject } from "./github.js";
import type { PrWorkflowHarness, PrWorkspaceChoice } from "./pullRequests.js";
import type { ComposerPrefs, DriverKind, EffortLevel, PermissionMode } from "./session.js";

export interface ResolvedWorkflowHarness {
  driver: DriverKind;
  model: string | undefined;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

export interface HarnessSummaryPart {
  key: "driver" | "model" | "effort" | "permission";
  label: string;
  source: "workflow" | "composer" | "fallback";
}

export interface WorkflowHarnessRequest {
  config: PrWorkflowHarness;
  composerDriver: DriverKind;
  pendingPrefs: ComposerPrefs;
  projectId: string | null;
}

export interface WorkflowHarnessResult {
  resolved: ResolvedWorkflowHarness;
  summary: { parts: HarnessSummaryPart[]; title: string };
  error: string | null;
}

export interface WorkflowBase {
  baseBranch: string | null;
  label: string;
}

export interface WorkflowPreviewRequest {
  workflowId: string;
  subject: WorkflowSubject;
  continueSessionId: string | null;
  workspace: PrWorkspaceChoice | null;
  promptOverride: string | null;
  composerDriver: DriverKind;
  pendingPrefs: ComposerPrefs;
}

export interface WorkflowPreview {
  activeWorkflowId: string;
  pickableWorkflowIds: string[];
  subject: WorkflowSubject;
  subjectLabel: string;
  updateMode: boolean;
  linkedSessionIds: string[];
  otherSessionIds: string[];
  otherSessionsLabel: string;
  projectId: string | null;
  needsClone: boolean;
  workspace: PrWorkspaceChoice;
  linkedWorktreeAvailable: boolean;
  driverMissing: boolean;
  harness: WorkflowHarnessResult | null;
  base: WorkflowBase | null;
  loaded: boolean;
  error: string | null;
  logsNeeded: boolean;
  logsReady: boolean;
  logsError: string | null;
  prompt: string | null;
  revision: string;
}

export interface WorkflowRunResume {
  sessionId: string;
  linked: boolean;
  note: string | null;
}

export interface WorkflowRunRequest extends WorkflowPreviewRequest {
  prompt: string;
  resume: WorkflowRunResume | null;
}

export type WorkflowRunStage = "clone" | "create" | "link" | "send" | "seen";

export type WorkflowRunResult =
  | { ok: true; sessionId: string }
  | { ok: false; stage: WorkflowRunStage; message: string; resume: WorkflowRunResume | null };
