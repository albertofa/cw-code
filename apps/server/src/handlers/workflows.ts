import type {
  ComposerPrefs,
  DriverKind,
  PrRef,
  PrWorkspaceChoice,
  WorkflowHarnessRequest,
  WorkflowPreviewRequest,
  WorkflowRunRequest,
  WorkflowRunResume,
  WorkflowSubject,
  WorkflowTemplatePreviewRequest
} from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { assertIssueRef, assertRunRef } from "../github/githubRefs.js";
import { assertPrRef } from "../github/PullRequestService.js";
import { DRIVER_KINDS } from "../prefs/PreferencesStore.js";
import { isPermissionMode } from "../providers/permissions.js";
import { sanitizeWorkflowHarness, VALID_EFFORTS, VALID_PR_WORKSPACES } from "../settings/SettingsStore.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseBoolean, parseOptionalBoolean, parseString } from "./shared.js";

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 200_000;
const MAX_ATTRIBUTION_LENGTH = 10_000;

function parseBounded(value: unknown, name: string, max: number): string {
  const text = parseString(value, name);
  if (text.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return text;
}

function parseNullable(value: unknown, name: string, max: number): string | null {
  return value === null || value === undefined ? null : parseBounded(value, name, max);
}

function parseDriver(value: unknown, name: string): DriverKind {
  if (typeof value !== "string" || !DRIVER_KINDS.includes(value as DriverKind)) throw new Error(`${name} must be claude, opencode or codex`);
  return value as DriverKind;
}

function parsePrRef(value: unknown): PrRef {
  assertPrRef(value as PrRef);
  const { host, owner, repo, number } = value as PrRef;
  return { host, owner, repo, number };
}

function parseSubject(value: unknown): WorkflowSubject {
  const subject = parseArgs(value, "subject");
  switch (subject.kind) {
    case "pr":
      return { kind: "pr", ref: parsePrRef(subject.ref) };
    case "issue":
      assertIssueRef(subject.ref);
      return { kind: "issue", ref: subject.ref };
    case "run":
      assertRunRef(subject.ref);
      return { kind: "run", ref: subject.ref };
    default:
      throw new Error("subject kind must be pr, issue or run");
  }
}

function parseWorkspace(value: unknown): PrWorkspaceChoice | null {
  if (value === null || value === undefined) return null;
  if (!VALID_PR_WORKSPACES.includes(value as PrWorkspaceChoice)) throw new Error("workspace must be checkout, worktree or linked");
  return value as PrWorkspaceChoice;
}

function parsePrefs(value: unknown): ComposerPrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const prefs: ComposerPrefs = {};
  if (typeof raw.model === "string" && raw.model.length <= MAX_ID_LENGTH) prefs.model = raw.model;
  if (typeof raw.variant === "string" && raw.variant.length <= MAX_ID_LENGTH) prefs.variant = raw.variant;
  if (VALID_EFFORTS.includes(raw.effort as NonNullable<ComposerPrefs["effort"]>)) prefs.effort = raw.effort as ComposerPrefs["effort"];
  if (isPermissionMode(raw.permissionMode)) prefs.permissionMode = raw.permissionMode;
  return prefs;
}

export function parsePreviewRequest(args: unknown): WorkflowPreviewRequest {
  const raw = parseArgs(args, "workflows.preview");
  return {
    workflowId: parseBounded(raw.workflowId, "workflowId", MAX_ID_LENGTH),
    subject: parseSubject(raw.subject),
    continueSessionId: parseNullable(raw.continueSessionId, "continueSessionId", MAX_ID_LENGTH),
    workspace: parseWorkspace(raw.workspace),
    promptOverride: parseNullable(raw.promptOverride, "promptOverride", MAX_TEXT_LENGTH),
    composerDriver: parseDriver(raw.composerDriver, "composerDriver"),
    pendingPrefs: parsePrefs(raw.pendingPrefs),
    ...(parseOptionalBoolean(raw.retry, "retry") ? { retry: true } : {})
  };
}

export function parseHarnessRequest(args: unknown): WorkflowHarnessRequest {
  const raw = parseArgs(args, "workflows.resolveHarness");
  return {
    config: sanitizeWorkflowHarness(raw.config),
    composerDriver: parseDriver(raw.composerDriver, "composerDriver"),
    pendingPrefs: parsePrefs(raw.pendingPrefs),
    projectId: parseNullable(raw.projectId, "projectId", MAX_ID_LENGTH)
  };
}

export function parseTemplatePreviewRequest(args: unknown): WorkflowTemplatePreviewRequest {
  const raw = parseArgs(args, "workflows.previewTemplate");
  return {
    template: parseBounded(raw.template, "template", MAX_TEXT_LENGTH),
    ref: parsePrRef(raw.ref),
    driver: parseDriver(raw.driver, "driver"),
    attribution: parseBounded(raw.attribution, "attribution", MAX_ATTRIBUTION_LENGTH),
    ...(parseOptionalBoolean(raw.retry, "retry") ? { retry: true } : {})
  };
}

function parseResume(value: unknown): WorkflowRunResume | null {
  if (value === null || value === undefined) return null;
  const raw = parseArgs(value, "resume");
  return {
    sessionId: parseBounded(raw.sessionId, "resume.sessionId", MAX_ID_LENGTH),
    linked: parseBoolean(raw.linked, "resume.linked"),
    sent: parseBoolean(raw.sent, "resume.sent"),
    note: parseNullable(raw.note, "resume.note", MAX_TEXT_LENGTH)
  };
}

export function parseRunRequest(args: unknown): WorkflowRunRequest {
  const raw = parseArgs(args, "workflows.run");
  const prompt = parseBounded(raw.prompt, "prompt", MAX_TEXT_LENGTH);
  if (!prompt.trim()) throw new Error("prompt must not be empty");
  const runId = parseBounded(raw.runId, "runId", MAX_ID_LENGTH);
  if (!runId) throw new Error("runId must not be empty");
  return {
    ...parsePreviewRequest(raw),
    runId,
    prompt,
    expectedRevision: parseNullable(raw.expectedRevision, "expectedRevision", MAX_ID_LENGTH),
    resume: parseResume(raw.resume)
  };
}

export function registerWorkflowHandlers(router: Router, app: ServerApp): void {
  const previews = () => app.requireServices().workflowPreview;
  handle(router, "workflows.preview", (args) => previews().preview(parsePreviewRequest(args)));
  handle(router, "workflows.resolveHarness", (args) => previews().resolveHarness(parseHarnessRequest(args)));
  handle(router, "workflows.previewTemplate", (args) => previews().previewTemplate(parseTemplatePreviewRequest(args)));
  handle(router, "workflows.run", (args) => app.requireServices().workflowRunner.run(parseRunRequest(args)));
}
