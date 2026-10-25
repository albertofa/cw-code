import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  FolderGit2,
  GitBranch,
  GitFork,
  History,
  Lock,
  Play,
  Plus,
  Settings2,
  X
} from "lucide-react";
import type { PrLinkOrigin, PrWorkflow, RepoRef, Session, WorkflowSubject } from "../cw.js";
import type { PrWorkspaceChoice, WorkflowPreviewRequest, WorkflowRunResume, WorkflowRunStage } from "@cw-code/contracts";
import { selectWhenListed, useAppStore } from "../stores/appStore.js";
import { usePrStore, type RunModalState } from "../stores/prStore.js";
import { harnessLabel } from "./toolTabs.js";
import { INHERITED_HARNESS } from "./workflowHarness.js";
import { workflowIcon } from "./workflowIcons.js";
import { shortenHome } from "./pathDisplay.js";
import { DriverIcon } from "./DriverIcon.js";
import { MenuSelect } from "./MenuSelect.js";
import { ipcErrorMessage } from "./ipcError.js";
import { findSession } from "../server/sidebarData.js";
import { useAppSettings, useAppSettingsError } from "./useAppSettings.js";
import { prKey } from "./prInbox.js";
import { usePrDataRevision } from "./usePrs.js";
import { IssueCard, PrCard, RunCard } from "./WorkflowSubjectCards.js";
import { SubjectCardSkeleton } from "./GitHubSkeletons.js";
import { Spinner } from "./Loading.js";
import { useRestoreBeforeSend } from "./sessionLifecycle.js";
import { useServerPreview } from "./useServerPreview.js";
import { useSessionRow } from "./useSessions.js";
import {
  baseWorkspaceHint,
  issueKey,
  prWorkspaceHint,
  repoOf,
  runKey,
  subjectKey,
  subjectLink
} from "./workflowSubject.js";

const READ_ONLY_NOTICE =
  "cw-code only reads from GitHub. Anything the session commits, pushes, or posts goes through the CLI's own permissions.";

const ORIGIN_LABEL: Record<PrLinkOrigin, string> = {
  opened: "opened here",
  workflow: "from a workflow",
  linked: "linked manually"
};

const SUBJECT_NOUN: Record<WorkflowSubject["kind"], string> = {
  pr: "pull request",
  issue: "issue",
  run: "workflow run"
};

function stageLabel(stage: WorkflowRunStage, noun: string): string {
  switch (stage) {
    case "clone":
      return "Cloning repository";
    case "create":
      return "Creating session";
    case "link":
      return `Linking session to the ${noun}`;
    case "send":
      return "Sending prompt";
    case "seen":
      return `Marking the ${noun} as seen`;
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest(".menu-panel") !== null || target.matches("textarea, input, select"));
}

function clonePathHint(root: string, ref: RepoRef, includeOwner: boolean): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return includeOwner ? `${base}${sep}${ref.owner}${sep}${ref.repo}` : `${base}${sep}${ref.repo}`;
}

function linkSignature(sessions: Session[]): string {
  return JSON.stringify(
    sessions.map((s) => [
      s.id,
      s.status,
      s.projectId,
      s.driver,
      s.worktreePath ?? null,
      (s.prs ?? []).map((link) => [prKey(link.ref), link.workflowId ?? null, link.lastSeenSha, link.lastSeenAt]),
      (s.issues ?? []).map((link) => [issueKey(link.ref), link.lastSeenAt]),
      (s.runs ?? []).map((link) => runKey(link.ref))
    ])
  );
}

function Segment<T extends string>({
  label,
  value,
  options,
  onPick,
  disabled
}: {
  label: string;
  value: T;
  options: Array<{ id: T; icon: ReactNode; title: string; hint: string }>;
  onPick: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="wf-run-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={`wf-run-seg-item${option.id === value ? " active" : ""}`}
          onClick={() => onPick(option.id)}
          disabled={disabled}
          title={option.hint}
        >
          <span className="wf-run-seg-icon" aria-hidden="true">{option.icon}</span>
          <span className="wf-run-seg-text">
            <span className="wf-run-seg-title">{option.title}</span>
            <span className="wf-run-seg-hint">{option.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function WorkflowRunModal({ request }: { request: RunModalState }) {
  const baseSubject = request.subject;
  const openSessionView = usePrStore((s) => s.openSessionView);
  const closeRunModal = usePrStore((s) => s.closeRunModal);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const projects = useAppStore((s) => s.projects);
  const pendingPrefs = useAppStore((s) => s.pendingPrefs);
  const composerDriver = useAppStore((s) => s.pendingDriver ?? s.lastDriver);
  const composerBySession = useAppStore((s) => s.composerBySession);
  const homeDir = useAppStore((s) => s.homeDir);
  const availableHarnesses = useAppStore((s) => s.availableHarnesses);

  const settings = useAppSettings();
  const settingsError = useAppSettingsError();
  const [workflowId, setWorkflowId] = useState(request.workflowId);
  const [target, setTarget] = useState(request.continueSessionId ?? "");
  const [workspaceChoice, setWorkspaceChoice] = useState<PrWorkspaceChoice | null>(null);
  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<WorkflowRunStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<WorkflowRunResume | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const runningRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const previewRequest = useMemo<WorkflowPreviewRequest>(
    () => ({
      workflowId,
      subject: baseSubject,
      continueSessionId: target || null,
      workspace: workspaceChoice,
      promptOverride: request.promptOverride ?? null,
      composerDriver,
      pendingPrefs
    }),
    [workflowId, baseSubject, target, workspaceChoice, request.promptOverride, composerDriver, pendingPrefs]
  );
  const requestKey = useMemo(() => JSON.stringify(previewRequest), [previewRequest]);
  const continueSession: Session | undefined = target ? findSession(sessionsByProject, target) : undefined;
  const sessionsSignature = useMemo(() => linkSignature(Object.values(sessionsByProject).flat()), [sessionsByProject]);
  const [previewSubject, setPreviewSubject] = useState<WorkflowSubject>(baseSubject);
  const subjectPrKey = previewSubject.kind === "pr" ? prKey(previewSubject.ref) : null;
  const prRevision = usePrDataRevision(subjectPrKey);
  const previewState = useServerPreview(
    requestKey,
    (retry) => window.cw.workflowPreview({ ...previewRequest, retry }),
    (value) => value.logsNeeded && !value.logsReady && !value.logsError,
    [prRevision, settings, sessionsSignature, availableHarnesses]
  );
  const preview = previewState.value;
  const live = preview !== null && previewState.current;
  const subject = preview?.subject ?? baseSubject;
  const activeWorkflowId = preview && (live || preview.babysitLocked) ? preview.activeWorkflowId : workflowId;
  const workflows = settings?.prWorkflows ?? [];
  const workflow: PrWorkflow | undefined = workflows.find((w) => w.id === activeWorkflowId);
  const pickable = (preview?.pickableWorkflowIds ?? [workflowId]).flatMap((id) => workflows.find((w) => w.id === id) ?? []);
  const noun = SUBJECT_NOUN[subject.kind];
  const repo = repoOf(subject);
  const sessionsFor = (ids: string[] | undefined): Session[] => (ids ?? []).flatMap((id) => findSession(sessionsByProject, id) ?? []);
  const linkedOptions = sessionsFor(preview?.linkedSessionIds);
  const otherSessions = sessionsFor(preview?.otherSessionIds);
  const { ensureOpen, dialog: restoreDialog } = useRestoreBeforeSend();
  const projectId = preview?.projectId ?? null;
  const updateMode = preview?.updateMode ?? false;
  const babysitLocked = preview?.babysitLocked ?? false;
  const projectNameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? "another project";
  const needsClone = !continueSession && (preview?.needsClone ?? false);
  const harnessConfig = workflow?.harness ?? INHERITED_HARNESS;
  const harnessResult = preview?.harness ?? null;
  const driver = harnessResult?.resolved.driver ?? harnessConfig.driver ?? composerDriver;
  const driverMissing = !continueSession && !resume && (preview?.driverMissing ?? false);
  const linkedWorktree = preview?.linkedWorktreeSessionId ? findSession(sessionsByProject, preview.linkedWorktreeSessionId) : undefined;
  const workspace: PrWorkspaceChoice = live ? preview.workspace : (workspaceChoice ?? preview?.workspace ?? "worktree");
  const base = preview?.base ?? null;
  const subjectText = preview?.subjectLabel ?? "";
  const working = stage !== null;
  const sessionBusy = (useSessionRow(continueSession?.id)?.busy ?? false) && !resume?.sent;
  const locked = resume !== null || uncertain;
  const lastActiveWorkflow = useRef(activeWorkflowId);
  const lastSubjectKind = useRef(preview?.subject.kind);

  useEffect(() => {
    if (subjectKey(subject) !== subjectKey(previewSubject)) setPreviewSubject(subject);
  }, [subjectKey(subject)]);

  useEffect(() => {
    if (lastActiveWorkflow.current === activeWorkflowId) return;
    lastActiveWorkflow.current = activeWorkflowId;
    setWorkspaceChoice(null);
  }, [activeWorkflowId]);

  useEffect(() => {
    const previous = lastSubjectKind.current;
    const next = preview?.subject.kind;
    lastSubjectKind.current = next;
    if (previous !== undefined && next !== undefined && previous !== next) setTarget("");
  }, [preview?.subject.kind]);

  useEffect(() => {
    if (continueSession) void useAppStore.getState().ensureComposer(continueSession.id);
  }, [continueSession?.id]);

  const revision = live ? preview.revision : null;
  useEffect(() => {
    if (!live || preview.prompt === null || dirty) return;
    setPrompt(preview.prompt);
  }, [revision]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const pickWorkflow = (id: string) => {
    setDirty(false);
    const next = workflows.find((w) => w.id === id);
    if (next && next.target !== subject.kind) setTarget("");
    setWorkflowId(id);
  };

  const pickTarget = (id: string) => {
    setDirty(false);
    setTarget(id);
  };

  const close = () => {
    if (!working) closeRunModal();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isTextEntry(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const finish = async (sessionId: string) => {
    await selectWhenListed(sessionId, () => {
      openSessionView();
      useAppStore.getState().selectSession(sessionId);
    });
    closeRunModal();
  };

  const configure = () => {
    if (!workflow || working) return;
    closeRunModal();
    usePrStore.getState().openWorkflowSettings(workflow.id);
  };

  const expectedStage = (): WorkflowRunStage => {
    if (continueSession) return resume?.sent ? (resume.linked ? "seen" : "link") : "send";
    if (!resume) return needsClone ? "clone" : "create";
    return !resume.linked ? "link" : !resume.sent ? "send" : "seen";
  };

  const run = async () => {
    if (!live || !preview.loaded || !workflow || runningRef.current || !prompt.trim()) return;
    runningRef.current = true;
    setError(null);
    setStage(expectedStage());
    try {
      if (continueSession && !resume && !uncertain && !(await ensureOpen(continueSession.id))) return;
      runIdRef.current ??= crypto.randomUUID();
      const result = await window.cw.runWorkflow({
        ...previewRequest,
        runId: runIdRef.current,
        prompt,
        expectedRevision: preview.revision,
        resume
      });
      setUncertain(false);
      if (result.ok) {
        if (!continueSession) useAppStore.setState({ lastDriver: driver });
        await finish(result.sessionId);
        return;
      }
      setResume(result.resume);
      setError(`${stageLabel(result.stage, noun)} failed: ${result.message}`);
      if (!result.resume) previewState.refresh();
    } catch (err) {
      const message = ipcErrorMessage(err);
      console.warn(`[workflow] ${subject.kind} run call failed: ${message}`);
      setUncertain(true);
      setError(`The run may have started on the server (${message}). Retry to check.`);
    } finally {
      runningRef.current = false;
      setStage(null);
    }
  };

  const WorkflowIcon = workflowIcon(workflow?.icon);
  const title = continueSession
    ? `Continue “${continueSession.title}”`
    : workflow
      ? `Run workflow · ${workflow.label}`
      : "Run workflow";
  const continueModel = continueSession ? composerBySession[continueSession.id]?.model : undefined;
  const summary = harnessResult?.summary ?? null;
  const hasOverride = Boolean(request.promptOverride?.trim());
  const promptLabel = !continueSession
    ? "Prompt"
    : !updateMode
      ? "Prompt (the workflow's start template, this session hasn't worked on it yet)"
      : hasOverride
        ? "Follow-up prompt"
        : "Follow-up prompt (the workflow's “on update” template)";
  const showPushNote = subject.kind === "pr" && !continueSession && preview?.pr?.viewerIsAuthor === true;
  const blocked =
    !live ||
    !preview.loaded ||
    !workflow ||
    !prompt.trim() ||
    !preview.logsReady ||
    sessionBusy ||
    driverMissing ||
    (!continueSession && !resume && !preview.harness);
  const startsContinuous = preview?.startsContinuous === true;
  const actionLabel = locked
    ? "Retry"
      : startsContinuous && workflow
        ? `Start ${workflow.label}`
        : continueSession
          ? "Send"
          : "Start session";
  const projectName = projectId ? projectNameOf(projectId) : repo.repo;
  const workspaceHint = (mode: "worktree" | "checkout"): string =>
    base ? baseWorkspaceHint(base, mode, projectName) : prWorkspaceHint(preview?.pr?.headRefName ?? null, mode, projectName);
  const card = !preview ? null : subject.kind === "pr" ? (
    preview.pr && <PrCard pr={preview.pr} />
  ) : subject.kind === "issue" ? (
    preview.issue && <IssueCard issue={preview.issue} />
  ) : (
    <RunCard run={preview.run ?? undefined} runRef={subject.ref} />
  );
  const loadError = preview?.error ?? null;
  const previewError = previewState.error;

  return (
    <>
      <div className="settings-backdrop" onClick={close}>
        <div
          ref={dialogRef}
          className="wf-run-modal"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="wf-run-head">
            <WorkflowIcon size={16} aria-hidden="true" />
            <h3 className="wf-run-title">{title}</h3>
            <button className="icon-btn" aria-label="Close" onClick={close} disabled={working}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="wf-run-body">
            {card || (!loadError && !previewError && <SubjectCardSkeleton label={`Loading ${noun}`} />)}
            {loadError && (
              <div className="wf-run-error" role="alert">
                Could not load the {noun}: {loadError}
                <button className="btn" onClick={previewState.retry}>
                  Retry
                </button>
              </div>
            )}
            {previewError && (
              <div className="wf-run-error" role="alert">
                Could not prepare this workflow run: {previewError}
                <button className="btn" onClick={previewState.retry}>
                  Retry
                </button>
              </div>
            )}
            {subject.kind === "run" && preview && !preview.run && (
              <div className="wf-run-status">
                <AlertTriangle size={12} aria-hidden="true" /> This run isn't in the loaded results, so its details are
                unavailable. Prompt variables that need them will be empty.
              </div>
            )}
            {settingsError && (
              <div className="wf-run-error" role="alert">
                Could not load workflows: {settingsError}
              </div>
            )}

            {needsClone && (
              <div className="wf-run-clone">
                <FolderGit2 size={15} aria-hidden="true" />
                <div className="wf-run-clone-text">
                  <span className="wf-run-clone-title">
                    Clone {repo.owner}/{repo.repo} and add it as a cw-code project
                  </span>
                  <span className="wf-run-muted">It isn't a project yet, so the session needs a local copy first.</span>
                  {settings && (
                    <span className="wf-run-path">{shortenHome(clonePathHint(settings.prCloneRoot, repo, settings.prCloneIncludeOwner), homeDir ?? undefined)}</span>
                  )}
                  {stage === "clone" && (
                    <span className="wf-run-status">
                      <Spinner size={12} /> Cloning…
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="wf-run-grid">
              <div className="wf-run-field">
                <span className="wf-run-label">Workflow</span>
                <MenuSelect
                  label="Workflow"
                  direction="down"
                  value={activeWorkflowId}
                  display={workflow?.label ?? "Choose workflow"}
                  icon={<WorkflowIcon size={14} />}
                  options={pickable.map((w) => {
                    const Icon = workflowIcon(w.icon);
                    return {
                      id: w.id,
                      label: w.label,
                      description: w.description,
                      icon: <Icon size={13} />,
                      disabled: working || locked
                    };
                  })}
                  onPick={pickWorkflow}
                />
              </div>
              <div className="wf-run-field">
                <span className="wf-run-label">Harness</span>
                {continueSession ? (
                  <div className="wf-run-locked" title="The session's harness and model are fixed">
                    <DriverIcon driver={continueSession.driver} size={14} />
                    <span className="wf-run-locked-text">
                      {harnessLabel(continueSession.driver)} · {continueModel ?? "same as session"}
                    </span>
                    <Lock size={12} aria-hidden="true" />
                  </div>
                ) : (
                  <div className="wf-run-locked wf-run-summary" title={summary?.title}>
                    <DriverIcon driver={driver} size={14} />
                    <span className="wf-run-locked-text">
                      {summary
                        ? summary.parts.map((part, index) => (
                            <span key={part.key} className={part.source === "workflow" ? undefined : "wf-run-inherited"}>
                              {index > 0 && " · "}
                              {part.label}
                            </span>
                          ))
                        : driverMissing
                          ? `${harnessLabel(driver)} · not installed`
                          : "Loading…"}
                    </span>
                    <button type="button" className="wf-run-config" onClick={configure} disabled={working || !workflow || locked}>
                      <Settings2 size={12} aria-hidden="true" /> Configure
                    </button>
                  </div>
                )}
              </div>
            </div>
            {workflow && <div className="wf-run-muted wf-run-desc">{workflow.description}</div>}
            {startsContinuous && workflow && (
              <div className="wf-run-status wf-run-continuous">
                <Activity size={12} aria-hidden="true" />
                Keeps running after this prompt: {workflow.label} sends its follow-up prompt by itself for failed checks,
                change requests and comments until the PR is merged or closed. Pause or stop it from the session.
              </div>
            )}
            {harnessResult?.error && !continueSession && (
              <div className="wf-run-error" role="alert">
                Could not list harness options: {harnessResult.error}
              </div>
            )}
            {driverMissing && (
              <div className="wf-run-error" role="alert">
                {harnessLabel(driver)} isn't installed. Configure this workflow to use an installed harness.
              </div>
            )}

            {(linkedOptions.length > 0 || otherSessions.length > 0) && (
              <div className="wf-run-field">
                <span className="wf-run-label">Session</span>
                <Segment
                  label="Session"
                  value={target}
                  disabled={working || locked || babysitLocked}
                  onPick={pickTarget}
                  options={[
                    {
                      id: "",
                      icon: <Plus size={14} />,
                      title: "New session",
                      hint: `linked to ${subjectText}`
                    },
                    ...linkedOptions.map((s) => {
                      const link = subjectLink(s, subject);
                      return {
                        id: s.id,
                        icon: <DriverIcon driver={s.driver} size={14} />,
                        title: `Continue “${s.title}”`,
                        hint: link ? ORIGIN_LABEL[link.origin] : `not linked to this ${noun}`
                      };
                    })
                  ]}
                />
              </div>
            )}

            {otherSessions.length > 0 && (
              <div className="wf-run-field">
                <span className="wf-run-label">{preview?.otherSessionsLabel ?? "Other sessions"}</span>
                <MenuSelect
                  label="Other sessions"
                  direction="down"
                  value={otherSessions.some((s) => s.id === target) ? target : ""}
                  display={otherSessions.find((s) => s.id === target)?.title ?? "Continue another session…"}
                  isSet={otherSessions.some((s) => s.id === target)}
                  options={otherSessions.map((s) => ({
                    id: s.id,
                    label: s.title,
                    hint: `will be linked to ${subjectText}${s.projectId === projectId ? "" : ` · ${projectNameOf(s.projectId)}`}`,
                    icon: <DriverIcon driver={s.driver} size={13} />,
                    disabled: working || locked || babysitLocked
                  }))}
                  onPick={pickTarget}
                  searchable={otherSessions.length > 5}
                  searchPlaceholder="Filter sessions…"
                />
              </div>
            )}

            {!continueSession && (
              <div className="wf-run-field">
                <span className="wf-run-label">Workspace</span>
                <Segment
                  label="Workspace"
                  value={workspace}
                  disabled={working || locked}
                  onPick={setWorkspaceChoice}
                  options={[
                    {
                      id: "checkout" as const,
                      icon: <GitBranch size={14} />,
                      title: "Current checkout",
                      hint: workspaceHint("checkout")
                    },
                    {
                      id: "worktree" as const,
                      icon: <GitFork size={14} />,
                      title: "New worktree",
                      hint: workspaceHint("worktree")
                    },
                    ...(linkedWorktree
                      ? [
                          {
                            id: "linked" as const,
                            icon: <History size={14} />,
                            title: "Linked worktree",
                            hint: `reuse “${linkedWorktree.title}”`
                          }
                        ]
                      : [])
                  ]}
                />
                {showPushNote && preview?.pr && (
                  <span className="wf-run-muted wf-run-note">
                    Unless your local {preview.pr.headRefName} matches the PR head, the session works on a new cw/ branch. The
                    prompt will tell it to update the PR with: git push origin HEAD:{preview.pr.headRefName}
                  </span>
                )}
              </div>
            )}

            <label className="wf-run-field">
              <span className="wf-run-label">
                {promptLabel}
              </span>
              <textarea
                className="field wf-run-prompt"
                value={prompt}
                onChange={(e) => {
                  setDirty(true);
                  setPrompt(e.target.value);
                }}
                disabled={working}
                spellCheck={false}
                placeholder={!preview || preview.prompt === null ? "Resolving template…" : undefined}
              />
            </label>
            {preview?.logsNeeded && !preview.logsReady && !preview.logsError && (
              <div className="wf-run-status">
                <Spinner size={12} /> Fetching failed {subject.kind === "pr" ? "check" : "run"} logs…
              </div>
            )}
            {preview?.logsError && (
              <div className="wf-run-error" role="alert">
                Could not fetch failed {subject.kind === "pr" ? "check" : "run"} logs: {preview.logsError}
                <button className="btn" onClick={previewState.retry}>
                  Retry
                </button>
              </div>
            )}
            {sessionBusy && <div className="wf-run-status">This session is running a turn. Wait for it to finish before sending.</div>}
            {error && (
              <div className="wf-run-error" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="wf-run-foot">
            <span className="wf-run-notice">
              <Lock size={12} aria-hidden="true" />
              {READ_ONLY_NOTICE}
            </span>
            <button className="btn" onClick={close} disabled={working}>
              Cancel
            </button>
            <button className="btn btn-primary wf-run-go" onClick={() => void run()} disabled={blocked || working}>
              {working ? <Spinner size={13} /> : <Play size={13} aria-hidden="true" />}
              {working && stage ? stageLabel(stage, noun) : actionLabel}
            </button>
          </div>
        </div>
      </div>
      {restoreDialog}
    </>
  );
}
