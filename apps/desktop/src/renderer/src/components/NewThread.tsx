import { useEffect, useState } from "react";
import { Download, Folder, GitBranch, GitFork, History } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import type { CreateSessionOptions, CreateWorkspaceMode, DriverName, GitBranchInfo } from "../cw.js";
import { useWorktreeCandidates } from "./useSessions.js";
import { shortenHome } from "./pathDisplay.js";
import { DriverIcon } from "./DriverIcon.js";
import { pickableHarnesses } from "./harnessAvailability.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";
import { useAppSettings } from "./useAppSettings.js";
import { MenuSelect } from "./MenuSelect.js";
import { NewSessionProjectPicker } from "./NewSessionProjectPicker.js";
import { ImportSessionsModal } from "./ImportSessionsModal.js";

const NO_PROJECT_HINT = "Choose a project to start a session";
const DEFAULT_BASE_ID = "";
const DEFAULT_BASE_LABEL = "Default branch (latest from origin)";

const HARNESS: Array<{ id: DriverName; label: string; blurb: string }> = [
  { id: "claude", label: "Claude", blurb: "Anthropic CLI harness" },
  { id: "opencode", label: "OpenCode", blurb: "Multi-provider, fast" },
  { id: "codex", label: "Codex", blurb: "OpenAI CLI harness" }
];

export function NewThread({
  projectId,
  driver,
  onDriverChange
}: {
  projectId: string | null;
  driver: DriverName;
  onDriverChange: (d: DriverName) => void;
}) {
  const prefs = useAppStore((s) => s.pendingPrefs);
  const settings = useAppSettings();
  const workspace = useAppStore((s) => s.pendingWorkspace);
  const newSessionError = useAppStore((s) => s.newSessionError);
  const installed = useAppStore((s) => s.installedHarnesses);
  const homeDir = useAppStore((s) => s.homeDir);
  const project = useAppStore((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchError, setBranchError] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const projectKey = project?.id ?? null;
  const store = useAppStore.getState();
  const candidates = useWorktreeCandidates(projectKey);

  useEffect(() => {
    let active = true;
    setBranches([]);
    setBranchError("");
    if (!projectKey) return;
    window.cw.listProjectBranches(projectKey).then((items) => {
      if (!active) return;
      setBranches(items);
      const pendingBase = useAppStore.getState().pendingWorkspace.baseBranch;
      if (pendingBase && !items.some((item) => item.name === pendingBase)) {
        store.setPendingWorkspace({ baseBranch: undefined });
      }
    }).catch((error: Error) => {
      if (active) setBranchError(error.message);
    });
    return () => { active = false; };
  }, [projectKey]);

  const candidatePaths = candidates.map((c) => c.worktreePath).join("\n");
  useEffect(() => {
    if (workspace.mode !== "previous" || !workspace.reuseWorktreePath) return;
    if (candidatePaths.split("\n").includes(workspace.reuseWorktreePath)) return;
    const first = candidates[0];
    store.setPendingWorkspace(
      first
        ? { reuseWorktreePath: first.worktreePath }
        : { mode: "new", reuseWorktreePath: undefined }
    );
  }, [candidatePaths, workspace.mode, workspace.reuseWorktreePath]);

  const rawMode: CreateWorkspaceMode = workspace.mode ?? (workspace.useWorktree === false ? "current" : "new");
  const mode: CreateWorkspaceMode = rawMode === "previous" && candidates.length === 0 ? "new" : rawMode;
  const selectedCandidate = candidates.find((c) => c.worktreePath === workspace.reuseWorktreePath) ?? candidates[0];

  const modeOptions = [
    {
      id: "current",
      label: "Local",
      description: `No worktree — switches ${project?.name ?? "the project"} to a new branch from the selected base`,
      icon: <Folder size={13} />
    },
    {
      id: "new",
      label: "New worktree",
      description: "Isolated worktree + fresh branch",
      icon: <GitFork size={13} />
    },
    ...(candidates.length > 0
      ? [{
          id: "previous",
          label: "Previous worktree",
          description: "Reuse a worktree from an earlier session",
          icon: <History size={13} />
        }]
      : [])
  ];

  const pickMode = (id: string) => {
    const next = id as CreateWorkspaceMode;
    const patch: CreateSessionOptions = { mode: next };
    if (next === "previous" && selectedCandidate) {
      patch.reuseWorktreePath = selectedCandidate.worktreePath;
    } else {
      patch.reuseWorktreePath = undefined;
    }
    store.setPendingWorkspace(patch);
  };

  const backend: ComposerBackend = {
    imageTarget: projectKey ? { projectId: projectKey } : {},
    prefs,
    prefsLoaded: true,
    busy: false,
    loadModels: () => (projectKey ? window.cw.listModelsFor(projectKey, driver) : window.cw.listModelsForHarness(driver)),
    loadPermissions: () =>
      projectKey ? window.cw.listPermissionsFor(projectKey, driver) : window.cw.listPermissionsForHarness(driver),
    loadFiles: () => (projectKey ? window.cw.listProjectFiles(projectKey) : Promise.resolve([])),
    loadCommands: () => (projectKey ? window.cw.listCommandsFor(projectKey, driver) : Promise.resolve([])),
    savePrefs: (p) => store.setPendingPrefs(p),
    send: (body, attachments, opts) =>
      store.sendPendingPrompt(body, attachments, {
        ...(opts?.command ? { command: opts.command } : {}),
        ...(opts?.skills ? { skills: opts.skills } : {})
      }),
    savePasteImage: (mime, data) =>
      projectKey ? window.cw.savePasteImage(projectKey, mime, data) : Promise.reject(new Error(NO_PROJECT_HINT)),
    interrupt: () => {}
  };

  const pickable = pickableHarnesses(installed);
  const harnessOptions = HARNESS.filter((h) => pickable.includes(h.id));

  const handleDriverChange = (next: DriverName) => {
    if (next === driver) return;
    onDriverChange(next);
  };

  const modeSelect = (
    <MenuSelect
      label="Workspace"
      title="Choose where this session works"
      direction="down"
      value={mode}
      display={modeOptions.find((o) => o.id === mode)?.label ?? "Workspace"}
      icon={modeOptions.find((o) => o.id === mode)?.icon}
      options={modeOptions}
      onPick={pickMode}
    />
  );

  const baseBranchSelect = (mode === "new" || mode === "current") && branches.length > 0 ? (
    <>
      <MenuSelect
        label="Base branch"
        title="Choose the branch this session starts from"
        direction="down"
        value={workspace.baseBranch ?? DEFAULT_BASE_ID}
        display={workspace.baseBranch ? (branches.find((item) => item.name === workspace.baseBranch)?.label ?? workspace.baseBranch) : DEFAULT_BASE_LABEL}
        icon={<GitBranch size={13} aria-hidden="true" />}
        options={[
          {
            id: DEFAULT_BASE_ID,
            label: DEFAULT_BASE_LABEL,
            description: "Fetched before the session branch is created",
            icon: <GitBranch size={13} />
          },
          ...branches.map((item) => ({
            id: item.name,
            label: item.label,
            hint: item.remote ? `${item.name} (remote)` : item.name,
            description: item.current ? "Current branch" : item.remote ? "Remote branch" : undefined,
            icon: <GitBranch size={13} />
          }))
        ]}
        onPick={(id) => store.setPendingWorkspace({ baseBranch: id === DEFAULT_BASE_ID ? undefined : id })}
        searchable
        searchPlaceholder="Filter branches…"
      />
      {mode === "current" && project && (
        <span className="workspace-hint">switches {project.name} to a new branch</span>
      )}
    </>
  ) : null;

  const reuseSelect = mode === "previous" && selectedCandidate ? (
    <MenuSelect
      label="Reuse worktree"
      title="Pick which earlier session worktree to continue in"
      direction="down"
      value={selectedCandidate.sessionId}
      display={selectedCandidate.title}
      icon={<History size={13} aria-hidden="true" />}
      options={candidates.map((c) => ({
        id: c.sessionId,
        label: c.title,
        hint: shortenHome(c.worktreePath, homeDir ?? undefined),
        description: c.branch ?? undefined
      }))}
      onPick={(sessionId) => {
        const picked = candidates.find((c) => c.sessionId === sessionId);
        if (picked) store.setPendingWorkspace({ reuseWorktreePath: picked.worktreePath });
      }}
    />
  ) : null;

  const currentBranch = branches.find((item) => item.current) ?? branches[0];

  const where = (
    <div className="composer-where">
      <NewSessionProjectPicker project={project} />
      {project && <span className="composer-dot" aria-hidden="true" />}
      {project && branchError && (
        <span className="workspace-hint" title={branchError}>Not a Git repository</span>
      )}
      {project && !branchError && (
        <>
          {modeSelect}
          {baseBranchSelect ?? reuseSelect ?? (currentBranch && (
            <span className="ws-current" title={`Working in the project on ${currentBranch.name}`}>
              <GitBranch size={13} aria-hidden="true" />
              <span className="ws-current-label">{currentBranch.label}</span>
            </span>
          ))}
        </>
      )}
    </div>
  );

  return (
    <div className="newthread">
      <h1 className="newthread-title">What should we build?</h1>
      <div className="newthread-composer">
        <ComposerView
          backend={backend}
          driver={driver}
          resetKey={`pending:${projectKey ?? ""}`}
          blockedReason={project ? undefined : NO_PROJECT_HINT}
          resetStaleModel
          settings={settings}
          recipePrefix={
            harnessOptions.length > 1 && (
              <>
                <div className="recipe-control recipe-harness" title="Agentic harness">
                  <MenuSelect
                    label="Harness"
                    title="Choose the agentic harness"
                    direction="down"
                    value={driver}
                    display={HARNESS.find((h) => h.id === driver)?.label ?? driver}
                    icon={<DriverIcon driver={driver} size={14} />}
                    options={harnessOptions.map((h) => ({
                      id: h.id, label: h.label, hint: h.blurb, description: h.blurb, icon: <DriverIcon driver={h.id} size={13} />
                    }))}
                    onPick={(id) => handleDriverChange(id as DriverName)}
                  />
                </div>
                <span className="composer-dot" aria-hidden="true" />
              </>
            )
          }
          top={where}
        />
        {newSessionError && (
          <div className="wf-run-error newthread-error" role="alert">
            {newSessionError}
          </div>
        )}
        <div className="newthread-import-row">
          <button
            type="button"
            className="newthread-import"
            onClick={() => setImportOpen(true)}
            title="Import a session started outside cw-code"
          >
            <Download size={13} aria-hidden="true" />
            Import session
          </button>
        </div>
      </div>
      {importOpen && <ImportSessionsModal initialDriver={driver} onClose={() => setImportOpen(false)} />}
    </div>
  );
}
