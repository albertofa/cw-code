import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  FolderGit2,
  GitBranch,
  GitFork,
  History,
  Loader2,
  Lock,
  Play,
  Plus,
  X
} from "lucide-react";
import type {
  ComposerPrefs,
  CreateSessionOptions,
  DriverName,
  ModelOption,
  PrLinkOrigin,
  PrRef,
  PrWorkflow,
  RepoRef,
  Session,
  WorkflowSubject
} from "../cw.js";
import type { PrWorkspaceChoice } from "@cw-code/contracts";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { useGitHubStore } from "../stores/githubStore.js";
import { usePrStore, type RunModalState } from "../stores/prStore.js";
import { resolveTemplate } from "./prWorkflows.js";
import { harnessLabel } from "./toolTabs.js";
import { firstDisplayedModelId, getLastModel } from "./lastModel.js";
import { shortenHome } from "./pathDisplay.js";
import { DriverIcon } from "./DriverIcon.js";
import { workflowIcon } from "./workflowIcons.js";
import { MenuSelect } from "./MenuSelect.js";
import { errorMessage } from "./errorMessage.js";
import { usePrSettings } from "./useLinkedPr.js";
import { IssueCard, PrCard, RunCard } from "./WorkflowSubjectCards.js";
import { useWorkflowSubjectData } from "./useWorkflowSubjectData.js";
import {
  effectiveSubject,
  findCachedRun,
  baseFailureHint,
  issueDataTime,
  repoOf,
  resolveIssueBase,
  resolveRunBase,
  subjectKey,
  subjectLink,
  workflowsForSubject,
  type WorktreeBase
} from "./workflowSubject.js";

const READ_ONLY_NOTICE =
  "cw-code only reads from GitHub. Anything the session commits, pushes, or posts goes through the CLI's own permissions.";

const HARNESSES: DriverName[] = ["claude", "opencode", "codex"];

const ORIGIN_LABEL: Record<PrLinkOrigin, string> = {
  opened: "opened here",
  workflow: "from a workflow",
  linked: "linked manually"
};

type Stage = "clone" | "create" | "link" | "send" | "seen";

const SUBJECT_NOUN: Record<WorkflowSubject["kind"], string> = {
  pr: "pull request",
  issue: "issue",
  run: "workflow run"
};

function stageLabel(stage: Stage, noun: string): string {
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

function pushNote(ref: PrRef, headRefName: string, sessionBranch: string): string {
  return `You are on branch ${sessionBranch}, not the PR head. To update PR #${ref.number}, push with: git push origin HEAD:${headRefName}`;
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest(".menu-panel") !== null || target.matches("textarea, input, select"));
}

function clonePathHint(root: string, ref: RepoRef): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${ref.owner}${sep}${ref.repo}`;
}

function newSessionHint(subject: WorkflowSubject, runNumber: number | undefined): string {
  switch (subject.kind) {
    case "pr":
      return `linked to #${subject.ref.number}`;
    case "issue":
      return `linked to #${subject.ref.number}`;
    case "run":
      return runNumber === undefined ? `linked to run ${subject.ref.runId}` : `linked to run #${runNumber}`;
  }
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
  const projectRepos = usePrStore((s) => s.projectRepos);
  const projectIdForRef = usePrStore((s) => s.projectIdForRef);
  const refreshProjectRepos = usePrStore((s) => s.refreshProjectRepos);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const closeRunModal = usePrStore((s) => s.closeRunModal);
  const runCaches = useGitHubStore((s) => s.runResults);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const pendingPrefs = useAppStore((s) => s.pendingPrefs);
  const lastDriver = useAppStore((s) => s.lastDriver);
  const composerBySession = useAppStore((s) => s.composerBySession);
  const busyTurns = useAppStore((s) => s.busyTurns);
  const homeDir = useAppStore((s) => s.homeDir);
  const settingsVersion = useAppStore((s) => s.settingsVersion);

  const { settings, error: settingsError } = usePrSettings();
  const [reposReady, setReposReady] = useState(false);
  const [workflowId, setWorkflowId] = useState(request.workflowId);
  const [target, setTarget] = useState(request.continueSessionId ?? "");
  const [driver, setDriver] = useState<DriverName>(lastDriver);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [workspaceChoice, setWorkspaceChoice] = useState<PrWorkspaceChoice | null>(null);
  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ sessionId: string; linked: boolean; note: string | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [baseState, setBaseState] = useState<{ request: string; base: WorktreeBase } | null>(null);
  const runningRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const cachedRun = useMemo(
    () => (baseSubject.kind === "run" ? findCachedRun(runCaches, baseSubject.ref) : undefined),
    [runCaches, baseSubject]
  );
  const workflows = useMemo(
    () => workflowsForSubject(settings?.prWorkflows ?? [], baseSubject, cachedRun),
    [settings, baseSubject, cachedRun]
  );
  const pickable = workflows.filter((w) => w.enabled || w.id === workflowId);
  const workflow: PrWorkflow | undefined = workflows.find((w) => w.id === workflowId);
  const subject = useMemo(() => effectiveSubject(baseSubject, workflow, cachedRun), [baseSubject, workflow, cachedRun]);
  const key = subjectKey(subject);
  const noun = SUBJECT_NOUN[subject.kind];
  const repo = repoOf(subject);

  const allSessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const linkedSessions = useMemo(
    () =>
      allSessions
        .filter((s) => s.status !== "archived" && subjectLink(s, subject) !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [allSessions, key]
  );
  const continueSession: Session | undefined = target ? allSessions.find((s) => s.id === target) : undefined;
  const targetOptions: Session[] =
    continueSession && !linkedSessions.includes(continueSession) ? [continueSession, ...linkedSessions] : linkedSessions;

  const projectId = useMemo(() => projectIdForRef(repo), [projectIdForRef, projectRepos, key]);
  const needsClone = !continueSession && reposReady && projectId === null;
  const effectiveDriver = continueSession?.driver ?? driver;
  const harness = harnessLabel(effectiveDriver);
  const linkedWorktree =
    subject.kind === "pr" ? linkedSessions.find((s) => s.worktreePath && s.projectId === projectId) : undefined;
  const requestedWorkspace = workspaceChoice ?? workflow?.workspace ?? "worktree";
  const workspace: PrWorkspaceChoice = requestedWorkspace === "linked" && !linkedWorktree ? "worktree" : requestedWorkspace;
  const template = workflow ? (continueSession ? workflow.updatePrompt : workflow.startPrompt) : "";
  const data = useWorkflowSubjectData({
    subject,
    cachedRun,
    template,
    continueSession,
    settings,
    hasWorkflow: workflow !== undefined,
    harness
  });
  const runBranch = data.run?.branch ?? null;
  const baseWanted = !continueSession && subject.kind !== "pr" && projectId !== null;
  const baseRequest = baseWanted ? [projectId, subject.kind, runBranch ?? ""].join("\n") : null;
  const base = baseRequest !== null && baseState?.request === baseRequest ? baseState.base : null;
  const baseLoading = workspace === "worktree" && baseRequest !== null && base === null;
  const working = stage !== null;
  const sessionBusy = continueSession ? busyTurns[continueSession.id] !== undefined : false;

  useEffect(() => {
    void refreshProjectRepos().finally(() => setReposReady(true));
  }, []);

  useEffect(() => {
    setWorkspaceChoice(null);
  }, [workflowId]);

  useEffect(() => {
    if (baseRequest === null || projectId === null) return;
    let active = true;
    void fetchBase(projectId).then((resolution) => {
      if (active) setBaseState({ request: baseRequest, base: resolution });
    });
    return () => {
      active = false;
    };
  }, [baseRequest]);

  useEffect(() => {
    if (continueSession) void useAppStore.getState().ensureComposer(continueSession.id);
  }, [continueSession?.id]);

  useEffect(() => {
    if (continueSession) return;
    let active = true;
    setModelsError(null);
    const load = projectId ? window.cw.listModelsFor(projectId, driver) : window.cw.listModelsForHarness(driver);
    load
      .then((list) => {
        if (!active) return;
        setModels(list);
        const last = getLastModel(driver);
        setModel(last && list.some((m) => m.id === last) ? last : firstDisplayedModelId(driver, list));
      })
      .catch((err: unknown) => {
        if (!active) return;
        setModels([]);
        setModel(undefined);
        setModelsError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [driver, projectId, continueSession?.id, settingsVersion]);

  const resolved = useMemo(() => {
    if (!data.vars || !workflow) return null;
    const text = resolveTemplate(template, data.vars);
    const override = request.promptOverride?.trim();
    if (!override) return text;
    return continueSession ? override : `${text}\n\n${override}`;
  }, [data.vars, workflow, continueSession, template, request.promptOverride]);

  const prefillKey = resolved === null ? null : [workflowId, target, data.revision, effectiveDriver].join("\n");
  useEffect(() => {
    if (prefillKey === null || resolved === null || dirty) return;
    setPrompt(resolved);
  }, [prefillKey]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const pickWorkflow = (id: string) => {
    setDirty(false);
    setWorkflowId(id);
    const next = workflows.find((w) => w.id === id);
    if (effectiveSubject(baseSubject, next, cachedRun).kind !== subject.kind) setTarget("");
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

  const fetchBase = async (targetProjectId: string): Promise<WorktreeBase> => {
    try {
      const branches = await window.cw.listProjectBranches(targetProjectId);
      return subject.kind === "run" ? resolveRunBase(branches, runBranch) : resolveIssueBase(branches);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[workflow] could not resolve the base branch for the ${subject.kind} workspace: ${message}`);
      return baseFailureHint(message);
    }
  };

  const workspaceOptions = async (targetProjectId: string | null): Promise<CreateSessionOptions> => {
    if (workspace === "checkout") return { mode: "current" };
    switch (subject.kind) {
      case "pr": {
        const detail = data.prDetail;
        if (!detail) return { mode: "current" };
        const prHead = {
          number: subject.ref.number,
          headRefName: detail.headRefName,
          headRefOid: detail.headRefOid,
          viewerIsAuthor: detail.viewerIsAuthor
        };
        if (workspace === "linked" && linkedWorktree?.worktreePath && linkedWorktree.projectId === targetProjectId) {
          return { mode: "previous", reuseWorktreePath: linkedWorktree.worktreePath, prHead };
        }
        return { mode: "new", prHead };
      }
      case "issue":
      case "run": {
        const resolution = base && targetProjectId === projectId ? base : targetProjectId ? await fetchBase(targetProjectId) : null;
        return resolution?.baseBranch ? { mode: "new", baseBranch: resolution.baseBranch } : { mode: "new" };
      }
    }
  };

  const linkSession = (sessionId: string, workflowIdToLink: string): Promise<Session> => {
    switch (subject.kind) {
      case "pr": {
        const detail = data.prDetail;
        if (!detail) throw new Error("pull request details are not loaded");
        return window.cw.linkSessionPr(sessionId, {
          ref: subject.ref,
          origin: "workflow",
          workflowId: workflowIdToLink,
          lastSeenSha: detail.headRefOid,
          lastSeenAt: Math.max(Date.now(), detail.updatedAt)
        });
      }
      case "issue": {
        const issue = data.issue;
        if (!issue) throw new Error("issue details are not loaded");
        return window.cw.linkSessionIssue(sessionId, {
          ref: subject.ref,
          origin: "workflow",
          workflowId: workflowIdToLink,
          lastSeenAt: issueDataTime(issue)
        });
      }
      case "run":
        return window.cw.linkSessionRun(sessionId, {
          ref: subject.ref,
          origin: "workflow",
          workflowId: workflowIdToLink,
          lastSeenAt: data.run?.updatedAt ?? Date.now()
        });
    }
  };

  const markSeen = async (sessionId: string): Promise<Session | null> => {
    switch (subject.kind) {
      case "pr": {
        const detail = data.prDetail;
        if (!detail) return null;
        return window.cw.markSessionPrSeen(sessionId, subject.ref, detail.headRefOid, detail.updatedAt);
      }
      case "issue":
        return data.issue ? window.cw.markSessionIssueSeen(sessionId, subject.ref, issueDataTime(data.issue)) : null;
      case "run":
        return data.run ? window.cw.markSessionRunSeen(sessionId, subject.ref, data.run.updatedAt) : null;
    }
  };

  const sendOptions = subject.kind === "pr" ? { prRefs: [subject.ref] } : undefined;

  const finish = (sessionId: string) => {
    openSessionView();
    useAppStore.getState().selectSession(sessionId);
    closeRunModal();
  };

  const run = async () => {
    if (!data.loaded || !workflow || runningRef.current || !prompt.trim()) return;
    runningRef.current = true;
    const app = useAppStore.getState();
    setError(null);
    let current: Stage = "send";
    try {
      if (continueSession) {
        current = "send";
        setStage(current);
        await app.ensureComposer(continueSession.id);
        await app.sendPromptTo(continueSession.id, prompt, undefined, sendOptions);
        current = "seen";
        setStage(current);
        const updated = await markSeen(continueSession.id);
        if (updated) app.applySession(updated);
        finish(continueSession.id);
        return;
      }
      let sessionId = created?.sessionId ?? null;
      let note = created?.note ?? null;
      if (!sessionId) {
        let targetProjectId = projectId;
        if (!targetProjectId) {
          current = "clone";
          setStage(current);
          const project = await window.cw.cloneGitHubRepo(subject.ref);
          await Promise.all([refreshProjectRepos(), app.loadProjects()]);
          targetProjectId = project.id;
        }
        current = "create";
        setStage(current);
        const prefs: ComposerPrefs = { ...DEFAULT_COMPOSER, ...pendingPrefs, model };
        const options = await workspaceOptions(targetProjectId);
        const session = await app.createSessionIn(targetProjectId, driver, prefs, options);
        sessionId = session.id;
        const detail = data.prDetail;
        note =
          subject.kind === "pr" &&
          detail &&
          options.mode !== "current" &&
          detail.viewerIsAuthor &&
          session.branch &&
          session.branch !== detail.headRefName
            ? pushNote(subject.ref, detail.headRefName, session.branch)
            : null;
        setCreated({ sessionId, linked: false, note });
      }
      if (!created?.linked) {
        current = "link";
        setStage(current);
        const linked = await linkSession(sessionId, workflow.id);
        useAppStore.getState().applySession(linked);
        setCreated({ sessionId, linked: true, note });
      }
      current = "send";
      setStage(current);
      await useAppStore.getState().sendPromptTo(sessionId, note ? `${prompt}\n\n${note}` : prompt, undefined, sendOptions);
      finish(sessionId);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[workflow] ${subject.kind} run failed at ${current}: ${message}`);
      setError(`${stageLabel(current, noun)} failed: ${message}`);
    } finally {
      runningRef.current = false;
      setStage(null);
    }
  };

  const WorkflowIcon = workflow ? workflowIcon(workflow.icon) : workflowIcon("sparkle");
  const title = continueSession
    ? `Continue “${continueSession.title}”`
    : workflow
      ? `Run workflow · ${workflow.label}`
      : "Run workflow";
  const continueModel = continueSession ? composerBySession[continueSession.id]?.model : undefined;
  const lockedDriver = continueSession?.driver ?? (created ? driver : null);
  const lockedModel = continueSession
    ? (continueModel ?? "same as session")
    : (models.find((m) => m.id === model)?.label ?? model ?? "default model");
  const hasOverride = Boolean(request.promptOverride?.trim());
  const promptLabel = !continueSession
    ? "Prompt"
    : hasOverride
      ? "Follow-up prompt"
      : "Follow-up prompt (the workflow's “on update” template)";
  const showPushNote = subject.kind === "pr" && !continueSession && workspace !== "checkout" && data.pr?.viewerIsAuthor === true;
  const blocked =
    !data.loaded || !workflow || !prompt.trim() || !data.logsReady || baseLoading || sessionBusy || (!continueSession && !reposReady);
  const actionLabel = continueSession ? "Send" : created ? "Retry" : "Start session";
  const worktreeHint =
    subject.kind === "pr"
      ? data.pr
        ? `isolated, from ${data.pr.headRefName}`
        : "isolated, from the PR head"
      : projectId === null
        ? "isolated, base branch resolved after cloning"
        : (base?.hint ?? "isolated, resolving base branch…");
  const card =
    subject.kind === "pr" ? (
      data.pr && <PrCard pr={data.pr} />
    ) : subject.kind === "issue" ? (
      data.issue && <IssueCard issue={data.issue} />
    ) : (
      <RunCard run={data.run} runRef={subject.ref} />
    );

  return (
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
          {card || (!data.error && <div className="wf-run-status">Loading {noun}…</div>)}
          {data.error && (
            <div className="wf-run-error" role="alert">
              Could not load the {noun}: {data.error}
              <button className="btn" onClick={data.retry}>
                Retry
              </button>
            </div>
          )}
          {subject.kind === "run" && !data.run && (
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
                  <span className="wf-run-path">{shortenHome(clonePathHint(settings.prCloneRoot, repo), homeDir ?? undefined)}</span>
                )}
                {stage === "clone" && (
                  <span className="wf-run-status">
                    <Loader2 size={12} className="wf-run-spin" aria-hidden="true" /> Cloning…
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
                value={workflowId}
                display={workflow?.label ?? "Choose workflow"}
                icon={<WorkflowIcon size={14} />}
                options={pickable.map((w) => {
                  const Icon = workflowIcon(w.icon);
                  return {
                    id: w.id,
                    label: w.label,
                    description: w.description,
                    icon: <Icon size={13} />,
                    disabled: working || created !== null
                  };
                })}
                onPick={pickWorkflow}
              />
            </div>
            <div className="wf-run-field">
              <span className="wf-run-label">Harness · model</span>
              {lockedDriver ? (
                <div className="wf-run-locked" title="The session's harness and model are fixed">
                  <DriverIcon driver={lockedDriver} size={14} />
                  <span className="wf-run-locked-text">
                    {harnessLabel(lockedDriver)} · {lockedModel}
                  </span>
                  <Lock size={12} aria-hidden="true" />
                </div>
              ) : (
                <div className="wf-run-pickers">
                  <MenuSelect
                    label="Harness"
                    direction="down"
                    value={driver}
                    display={harnessLabel(driver)}
                    icon={<DriverIcon driver={driver} size={14} />}
                    options={HARNESSES.map((id) => ({
                      id,
                      label: harnessLabel(id),
                      icon: <DriverIcon driver={id} size={13} />,
                      disabled: working
                    }))}
                    onPick={(id) => setDriver(id as DriverName)}
                  />
                  <MenuSelect
                    label="Model"
                    direction="down"
                    value={model ?? ""}
                    display={models.find((m) => m.id === model)?.label ?? model ?? "Default model"}
                    options={models.map((m) => ({ id: m.id, label: m.label, hint: m.id, disabled: working }))}
                    onPick={setModel}
                    searchable
                    searchPlaceholder="Filter models…"
                  />
                </div>
              )}
            </div>
          </div>
          {workflow && <div className="wf-run-muted wf-run-desc">{workflow.description}</div>}
          {modelsError && !continueSession && (
            <div className="wf-run-error" role="alert">
              Could not list models: {modelsError}
            </div>
          )}

          {targetOptions.length > 0 && (
            <div className="wf-run-field">
              <span className="wf-run-label">Session</span>
              <Segment
                label="Session"
                value={target}
                disabled={working || created !== null}
                onPick={pickTarget}
                options={[
                  { id: "", icon: <Plus size={14} />, title: "New session", hint: newSessionHint(subject, data.run?.runNumber) },
                  ...targetOptions.map((s) => {
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

          {!continueSession && (
            <div className="wf-run-field">
              <span className="wf-run-label">Workspace</span>
              <Segment
                label="Workspace"
                value={workspace}
                disabled={working || created !== null}
                onPick={setWorkspaceChoice}
                options={[
                  {
                    id: "checkout" as const,
                    icon: <GitBranch size={14} />,
                    title: "Current checkout",
                    hint: "work in the project on its current branch"
                  },
                  {
                    id: "worktree" as const,
                    icon: <GitFork size={14} />,
                    title: "New worktree",
                    hint: worktreeHint
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
              {showPushNote && data.pr && (
                <span className="wf-run-muted wf-run-note">
                  Unless your local {data.pr.headRefName} matches the PR head, the session works on a new cw/ branch. The
                  prompt will tell it to update the PR with: git push origin HEAD:{data.pr.headRefName}
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
              placeholder={resolved === null ? "Resolving template…" : undefined}
            />
          </label>
          {data.logsNeeded && !data.logsReady && !data.logsError && (
            <div className="wf-run-status">
              <Loader2 size={12} className="wf-run-spin" aria-hidden="true" /> Fetching failed {subject.kind === "pr" ? "check" : "run"} logs…
            </div>
          )}
          {data.logsError && (
            <div className="wf-run-error" role="alert">
              Could not fetch failed {subject.kind === "pr" ? "check" : "run"} logs: {data.logsError}
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
            {working ? <Loader2 size={13} className="wf-run-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {working && stage ? stageLabel(stage, noun) : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
