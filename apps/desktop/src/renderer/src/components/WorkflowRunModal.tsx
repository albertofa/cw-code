import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Eye,
  FolderGit2,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  Plus,
  Sparkles,
  Wrench,
  X,
  type LucideIcon
} from "lucide-react";
import type {
  ComposerPrefs,
  CreateSessionOptions,
  DriverName,
  ModelOption,
  PrCheck,
  PrDetail,
  PrLinkOrigin,
  PrRef,
  PrSummary,
  PrWorkflow,
  Session
} from "../cw.js";
import type { PrWorkflowIcon, PrWorkspaceChoice } from "@cw-code/contracts";
import { useAppStore, DEFAULT_COMPOSER } from "../stores/appStore.js";
import { usePrStore, type RunModalState } from "../stores/prStore.js";
import { prKey } from "./prInbox.js";
import { linkFor } from "./sessionPrLinks.js";
import { prChip } from "./prChip.js";
import { updatesSince } from "./prUpdates.js";
import { attributionText, resolveTemplate, templateVars } from "./prWorkflows.js";
import { harnessLabel } from "./toolTabs.js";
import { firstDisplayedModelId, getLastModel } from "./lastModel.js";
import { shortenHome } from "./pathDisplay.js";
import { DriverIcon } from "./DriverIcon.js";
import { MenuSelect } from "./MenuSelect.js";
import { errorMessage } from "./errorMessage.js";
import { needsFailedLogs } from "./prSessionModel.js";
import { usePrSettings } from "./useLinkedPr.js";

const READ_ONLY_NOTICE =
  "cw-code only reads from GitHub. Anything the session commits, pushes, or posts goes through the CLI's own permissions.";

const FAILED_LOG_TAIL_CHARS = 12_000;

const FAILED_LOGS_TOTAL_CHARS = 30_000;

const HARNESSES: DriverName[] = ["claude", "opencode", "codex"];

const WORKFLOW_ICONS: Record<PrWorkflowIcon, LucideIcon> = {
  eye: Eye,
  activity: Activity,
  message: MessageSquare,
  wrench: Wrench,
  merge: GitMerge,
  bot: Bot,
  sparkle: Sparkles
};

const ORIGIN_LABEL: Record<PrLinkOrigin, string> = {
  opened: "opened here",
  workflow: "from a workflow",
  linked: "linked manually"
};

type Stage = "clone" | "create" | "link" | "send" | "seen";

const STAGE_LABEL: Record<Stage, string> = {
  clone: "Cloning repository",
  create: "Creating session",
  link: "Linking session to the pull request",
  send: "Sending prompt",
  seen: "Marking the pull request as seen"
};

function failingRuns(checks: PrCheck[]): Array<{ runId: number; names: string[] }> {
  const byRun = new Map<number, string[]>();
  for (const check of checks) {
    if (check.status !== "failure" || check.runId === null) continue;
    byRun.set(check.runId, [...(byRun.get(check.runId) ?? []), check.name]);
  }
  return [...byRun.entries()].map(([runId, names]) => ({ runId, names }));
}

function tail(text: string): string {
  return text.length > FAILED_LOG_TAIL_CHARS ? `[…truncated]\n${text.slice(-FAILED_LOG_TAIL_CHARS)}` : text;
}

async function loadFailedLogs(ref: PrRef, checks: PrCheck[]): Promise<string> {
  const runs = failingRuns(checks);
  const logs = await Promise.all(
    runs.map(async (run) => `### ${run.names.join(", ")} (run ${run.runId})\n${tail((await window.cw.getPrCheckLog(ref, run.runId)).trim())}`)
  );
  const joined = logs.join("\n\n");
  return joined.length > FAILED_LOGS_TOTAL_CHARS ? `${joined.slice(0, FAILED_LOGS_TOTAL_CHARS)}\n[…more logs truncated]` : joined;
}

function pushNote(ref: PrRef, headRefName: string, sessionBranch: string): string {
  return `You are on branch ${sessionBranch}, not the PR head. To update PR #${ref.number}, push with: git push origin HEAD:${headRefName}`;
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest(".menu-panel") !== null || target.matches("textarea, input, select"));
}

function clonePathHint(root: string, ref: PrRef): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${ref.owner}${sep}${ref.repo}`;
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

function PrCard({ pr }: { pr: PrSummary }) {
  const chip = prChip({ pr, git: null });
  return (
    <div className="wf-run-pr">
      <GitPullRequest size={16} aria-hidden="true" className="wf-run-pr-icon" />
      <div className="wf-run-pr-text">
        <div className="wf-run-pr-title" title={pr.title}>
          {pr.title} <span className="wf-run-muted">#{pr.ref.number}</span>
        </div>
        <div className="wf-run-pr-meta">
          <span>{pr.ref.owner}/{pr.ref.repo}</span>
          <span aria-hidden="true">·</span>
          <span className="wf-run-branch">{pr.headRefName}</span>
          <span aria-hidden="true">→</span>
          <span className="wf-run-branch">{pr.baseRefName}</span>
        </div>
      </div>
      {chip && (
        <span className={`pr-chip tone-${chip.tone}`} title={chip.title}>
          {chip.title.replace(/^PR #\d+ · /, "")}
        </span>
      )}
    </div>
  );
}

export function WorkflowRunModal({ request }: { request: RunModalState }) {
  const { ref } = request;
  const key = prKey(ref);
  const detail: PrDetail | undefined = usePrStore((s) => s.detailByKey[key]);
  const detailError = usePrStore((s) => s.detailErrorByKey[key]);
  const summary = usePrStore((s) => s.inbox?.items.find((item) => prKey(item.ref) === key));
  const projectRepos = usePrStore((s) => s.projectRepos);
  const projectIdForRef = usePrStore((s) => s.projectIdForRef);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const refreshProjectRepos = usePrStore((s) => s.refreshProjectRepos);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const closeRunModal = usePrStore((s) => s.closeRunModal);
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
  const [failedLogs, setFailedLogs] = useState<{ sha: string; text: string } | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ sessionId: string; linked: boolean; note: string | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const runningRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const allSessions = useMemo(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const linkedSessions = useMemo(
    () =>
      allSessions
        .filter((s) => s.status !== "archived" && linkFor(s, ref) !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [allSessions, key]
  );
  const continueSession: Session | undefined = target ? allSessions.find((s) => s.id === target) : undefined;
  const targetOptions: Session[] =
    continueSession && !linkedSessions.includes(continueSession) ? [continueSession, ...linkedSessions] : linkedSessions;

  const projectId = useMemo(() => projectIdForRef(ref), [projectIdForRef, projectRepos, ref]);
  const needsClone = !continueSession && reposReady && projectId === null;
  const workflows = settings?.prWorkflows ?? [];
  const pickable = workflows.filter((w) => w.enabled || w.id === workflowId);
  const workflow: PrWorkflow | undefined = workflows.find((w) => w.id === workflowId);
  const effectiveDriver = continueSession?.driver ?? driver;
  const harness = harnessLabel(effectiveDriver);
  const linkedWorktree = linkedSessions.find((s) => s.worktreePath && s.projectId === projectId);
  const requestedWorkspace = workspaceChoice ?? workflow?.workspace ?? "worktree";
  const workspace: PrWorkspaceChoice = requestedWorkspace === "linked" && !linkedWorktree ? "worktree" : requestedWorkspace;
  const template = workflow ? (continueSession ? workflow.updatePrompt : workflow.startPrompt) : "";
  const needsLogs = needsFailedLogs(template);
  const logsReady = !needsLogs || (detail !== undefined && failedLogs?.sha === detail.headRefOid);
  const working = stage !== null;
  const sessionBusy = continueSession ? busyTurns[continueSession.id] !== undefined : false;
  const pr: PrSummary | undefined = detail ?? summary;

  useEffect(() => {
    void loadDetail(ref);
    void refreshProjectRepos().finally(() => setReposReady(true));
  }, [key]);

  useEffect(() => {
    setWorkspaceChoice(null);
  }, [workflowId]);

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

  const headSha = detail?.headRefOid;
  useEffect(() => {
    if (!needsLogs || !detail || failedLogs?.sha === detail.headRefOid) return;
    let active = true;
    setLogsError(null);
    loadFailedLogs(ref, detail.checkRuns)
      .then((text) => {
        if (active) setFailedLogs({ sha: detail.headRefOid, text });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLogsError(errorMessage(err));
        setFailedLogs({ sha: detail.headRefOid, text: "" });
      });
    return () => {
      active = false;
    };
  }, [needsLogs, headSha]);

  const resolved = useMemo(() => {
    if (!detail || !workflow || !settings || !logsReady) return null;
    const link = continueSession ? linkFor(continueSession, ref) : undefined;
    const vars = templateVars(detail, {
      link,
      updates: continueSession && link ? updatesSince(detail, link) : undefined,
      failedLogs: needsLogs ? failedLogs?.text : undefined,
      attribution: attributionText(settings, harness),
      harness
    });
    const text = resolveTemplate(template, vars);
    const override = request.promptOverride?.trim();
    if (!override) return text;
    return continueSession ? override : `${text}\n\n${override}`;
  }, [detail, workflow, settings, logsReady, continueSession, needsLogs, failedLogs, harness, template, request.promptOverride]);

  const prefillKey = resolved === null ? null : [workflowId, target, headSha ?? "", effectiveDriver].join("\n");
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

  const workspaceOptions = (targetProjectId: string | null): CreateSessionOptions => {
    if (workspace === "checkout" || !detail) return { mode: "current" };
    const prHead = {
      number: ref.number,
      headRefName: detail.headRefName,
      headRefOid: detail.headRefOid,
      viewerIsAuthor: detail.viewerIsAuthor
    };
    if (workspace === "linked" && linkedWorktree?.worktreePath && linkedWorktree.projectId === targetProjectId) {
      return { mode: "previous", reuseWorktreePath: linkedWorktree.worktreePath, prHead };
    }
    return { mode: "new", prHead };
  };

  const finish = (sessionId: string) => {
    openSessionView();
    useAppStore.getState().selectSession(sessionId);
    closeRunModal();
  };

  const run = async () => {
    if (!detail || !workflow || runningRef.current || !prompt.trim()) return;
    runningRef.current = true;
    const app = useAppStore.getState();
    setError(null);
    let current: Stage = "send";
    try {
      if (continueSession) {
        current = "send";
        setStage(current);
        await app.ensureComposer(continueSession.id);
        await app.sendPromptTo(continueSession.id, prompt, undefined, { prRefs: [ref] });
        current = "seen";
        setStage(current);
        app.applySession(await window.cw.markSessionPrSeen(continueSession.id, ref, detail.headRefOid, detail.updatedAt));
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
          const project = await window.cw.clonePrRepo(ref);
          await Promise.all([refreshProjectRepos(), app.loadProjects()]);
          targetProjectId = project.id;
        }
        current = "create";
        setStage(current);
        const prefs: ComposerPrefs = { ...DEFAULT_COMPOSER, ...pendingPrefs, model };
        const options = workspaceOptions(targetProjectId);
        const session = await app.createSessionIn(targetProjectId, driver, prefs, options);
        sessionId = session.id;
        note =
          options.mode !== "current" && detail.viewerIsAuthor && session.branch && session.branch !== detail.headRefName
            ? pushNote(ref, detail.headRefName, session.branch)
            : null;
        setCreated({ sessionId, linked: false, note });
      }
      if (!created?.linked) {
        current = "link";
        setStage(current);
        const linked = await window.cw.linkSessionPr(sessionId, {
          ref,
          origin: "workflow",
          workflowId: workflow.id,
          lastSeenSha: detail.headRefOid,
          lastSeenAt: Math.max(Date.now(), detail.updatedAt)
        });
        useAppStore.getState().applySession(linked);
        setCreated({ sessionId, linked: true, note });
      }
      current = "send";
      setStage(current);
      await useAppStore.getState().sendPromptTo(sessionId, note ? `${prompt}\n\n${note}` : prompt, undefined, { prRefs: [ref] });
      finish(sessionId);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[pr] workflow run failed at ${current}: ${message}`);
      setError(`${STAGE_LABEL[current]} failed: ${message}`);
    } finally {
      runningRef.current = false;
      setStage(null);
    }
  };

  const WorkflowIcon = workflow ? WORKFLOW_ICONS[workflow.icon] ?? Sparkles : Sparkles;
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
  const showPushNote = !continueSession && workspace !== "checkout" && pr?.viewerIsAuthor === true;
  const blocked = !detail || !workflow || !prompt.trim() || !logsReady || sessionBusy || (!continueSession && !reposReady);
  const actionLabel = continueSession ? "Send" : created ? "Retry" : "Start session";

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
          {pr ? <PrCard pr={pr} /> : !detailError && <div className="wf-run-status">Loading pull request…</div>}
          {detailError && (
            <div className="wf-run-error" role="alert">
              Could not load the pull request: {detailError}
              <button className="btn" onClick={() => void loadDetail(ref)}>
                Retry
              </button>
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
                  Clone {ref.owner}/{ref.repo} and add it as a cw-code project
                </span>
                <span className="wf-run-muted">It isn't a project yet, so the session needs a local copy first.</span>
                {settings && (
                  <span className="wf-run-path">{shortenHome(clonePathHint(settings.prCloneRoot, ref), homeDir ?? undefined)}</span>
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
                  const Icon = WORKFLOW_ICONS[w.icon] ?? Sparkles;
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
                  { id: "", icon: <Plus size={14} />, title: "New session", hint: `linked to #${ref.number}` },
                  ...targetOptions.map((s) => {
                    const link = linkFor(s, ref);
                    return {
                      id: s.id,
                      icon: <DriverIcon driver={s.driver} size={14} />,
                      title: `Continue “${s.title}”`,
                      hint: link ? ORIGIN_LABEL[link.origin] : "not linked to this pull request"
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
                    hint: pr ? `isolated, from ${pr.headRefName}` : "isolated, from the PR head"
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
              {showPushNote && pr && (
                <span className="wf-run-muted wf-run-note">
                  Unless your local {pr.headRefName} matches the PR head, the session works on a new cw/ branch. The
                  prompt will tell it to update the PR with: git push origin HEAD:{pr.headRefName}
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
          {needsLogs && !logsReady && !logsError && (
            <div className="wf-run-status">
              <Loader2 size={12} className="wf-run-spin" aria-hidden="true" /> Fetching failed check logs…
            </div>
          )}
          {logsError && (
            <div className="wf-run-error" role="alert">
              Could not fetch failed check logs: {logsError}
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
            {working && stage ? STAGE_LABEL[stage] : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
