import { useEffect, useState } from "react";
import { GitBranch, GitFork, History } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import type { CreateSessionOptions, CreateWorkspaceMode, DriverName, GitBranchInfo, Session } from "../cw.js";
import { worktreeCandidates } from "./worktreeCandidates.js";
import { shortenHome } from "./pathDisplay.js";
import { DriverIcon } from "./DriverIcon.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";
import { MenuSelect } from "./MenuSelect.js";
import { NewSessionAddProject, NewSessionProjectPicker } from "./NewSessionProjectPicker.js";

const NO_PROJECT_HINT = "Choose a project to start a session";
const NO_SESSIONS: Session[] = [];

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
  const store = useAppStore();
  const prefs = useAppStore((s) => s.pendingPrefs);
  const modelsRefreshKey = useAppStore((s) => s.settingsVersion);
  const workspace = useAppStore((s) => s.pendingWorkspace);
  const homeDir = useAppStore((s) => s.homeDir);
  const project = useAppStore((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchError, setBranchError] = useState("");

  const projectKey = project?.id ?? null;
  const sessions = projectKey ? (store.sessionsByProject[projectKey] ?? NO_SESSIONS) : NO_SESSIONS;
  const candidates = worktreeCandidates(sessions);

  useEffect(() => {
    let active = true;
    setBranches([]);
    setBranchError("");
    if (!projectKey) return;
    window.cw.listProjectBranches(projectKey).then((items) => {
      if (!active) return;
      setBranches(items);
      const current = items.find((item) => item.current) ?? items[0];
      if ((!workspace.baseBranch || !items.some((item) => item.name === workspace.baseBranch)) && current) {
        store.setPendingWorkspace({ baseBranch: current.name });
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
      label: "Current checkout",
      description: "Work directly in the project on the current branch",
      icon: <GitBranch size={13} />
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
    busy: false,
    loadModels: () => (projectKey ? window.cw.listModelsFor(projectKey, driver) : window.cw.listModelsForHarness(driver)),
    loadPermissions: () =>
      projectKey ? window.cw.listPermissionsFor(projectKey, driver) : window.cw.listPermissionsForHarness(driver),
    loadFiles: () => (projectKey ? window.cw.listProjectFiles(projectKey) : Promise.resolve([])),
    savePrefs: (p) => store.setPendingPrefs(p),
    send: (body, attachments) => store.sendPendingPrompt(body, attachments),
    savePasteImage: (mime, data) =>
      projectKey ? window.cw.savePasteImage(projectKey, mime, data) : Promise.reject(new Error(NO_PROJECT_HINT)),
    interrupt: () => {}
  };

  const handleDriverChange = (next: DriverName) => {
    if (next === driver) return;
    onDriverChange(next);
  };

  const modeSelect = (
    <MenuSelect
      label="Workspace"
      title="Choose where this session works"
      value={mode}
      display={modeOptions.find((o) => o.id === mode)?.label ?? "Workspace"}
      icon={modeOptions.find((o) => o.id === mode)?.icon}
      options={modeOptions}
      onPick={pickMode}
    />
  );

  const baseBranchSelect = mode === "new" && branches.length > 0 ? (
    <MenuSelect
      label="Base branch"
      title="Choose the branch this session starts from"
      value={workspace.baseBranch ?? branches[0].name}
      display={branches.find((item) => item.name === workspace.baseBranch)?.label ?? "Choose base branch"}
      icon={<GitBranch size={13} aria-hidden="true" />}
      options={branches.map((item) => ({
        id: item.name,
        label: item.label,
        hint: item.remote ? `${item.name} (remote)` : item.name,
        description: item.current ? "Current branch" : item.remote ? "Remote branch" : undefined,
        icon: <GitBranch size={13} />
      }))}
      onPick={(baseBranch) => store.setPendingWorkspace({ baseBranch })}
      searchable
      searchPlaceholder="Filter branches…"
    />
  ) : null;

  const reuseSelect = mode === "previous" && selectedCandidate ? (
    <MenuSelect
      label="Reuse worktree"
      title="Pick which earlier session worktree to continue in"
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

  return (
    <div className="newthread">
      <h1 className="newthread-title">What should we build?</h1>
      <div className="newthread-context">
        <NewSessionProjectPicker project={project} />
        <NewSessionAddProject />
      </div>
      <div className="newthread-composer">
        <ComposerView
          backend={backend}
          driver={driver}
          resetKey={`pending:${projectKey ?? ""}`}
          blockedReason={project ? undefined : NO_PROJECT_HINT}
          resetStaleModel
          modelsRefreshKey={modelsRefreshKey}
          recipePrefix={
            <div className="recipe-control" title="Agentic harness">
              <MenuSelect
                label="Harness"
                title="Choose the agentic harness"
                direction="down"
                value={driver}
                display={HARNESS.find((h) => h.id === driver)?.label ?? driver}
                icon={<DriverIcon driver={driver} size={16} />}
                options={HARNESS.map((h) => ({
                  id: h.id, label: h.label, hint: h.blurb, description: h.blurb, icon: <DriverIcon driver={h.id} size={13} />
                }))}
                onPick={(id) => handleDriverChange(id as DriverName)}
              />
            </div>
          }
          footer={
            <div className="composer-footer">
              {!project ? (
                <span className="workspace-hint">{NO_PROJECT_HINT}</span>
              ) : branchError ? (
                <span className="workspace-hint" title={branchError}>Not a Git repository</span>
              ) : (
                <>
                  <div className="ws-side">{modeSelect}</div>
                  <div className="ws-side">
                    {baseBranchSelect ?? reuseSelect ?? (currentBranch && (
                      <span className="ws-current" title={`Working in the project on ${currentBranch.name}`}>
                        <GitBranch size={13} aria-hidden="true" />
                        {currentBranch.label}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
