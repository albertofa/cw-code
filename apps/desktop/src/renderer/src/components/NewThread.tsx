import { useEffect, useState } from "react";
import { GitBranch, GitFork, History } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import type { CreateSessionOptions, CreateWorkspaceMode, DriverName, GitBranchInfo } from "../cw.js";
import { worktreeCandidates } from "./worktreeCandidates.js";
import { DriverIcon } from "./DriverIcon.js";
import { ComposerView, type ComposerBackend } from "./ComposerView.js";
import { MenuSelect } from "./MenuSelect.js";

const HARNESS: Array<{ id: DriverName; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" }
];

export function NewThread({
  projectId,
  projectName,
  driver,
  onDriverChange
}: {
  projectId: string;
  projectName: string;
  driver: DriverName;
  onDriverChange: (d: DriverName) => void;
}) {
  const store = useAppStore();
  const prefs = useAppStore((s) => s.pendingPrefs);
  const modelsRefreshKey = useAppStore((s) => s.settingsVersion);
  const workspace = useAppStore((s) => s.pendingWorkspace);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchError, setBranchError] = useState("");

  const sessions = store.sessionsByProject[projectId] ?? [];
  const candidates = worktreeCandidates(sessions);

  useEffect(() => {
    let active = true;
    setBranches([]);
    setBranchError("");
    window.cw.listProjectBranches(projectId).then((items) => {
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
  }, [projectId]);

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
    imageTarget: { projectId },
    prefs,
    busy: false,
    loadModels: () => window.cw.listModelsFor(projectId, driver),
    loadFiles: () => window.cw.listProjectFiles(projectId),
    savePrefs: (p) => store.setPendingPrefs(p),
    send: (body, attachments) => store.sendPendingPrompt(body, attachments),
    savePasteImage: (mime, data) => window.cw.savePasteImage(projectId, mime, data),
    interrupt: () => {}
  };

  return (
    <div className="newthread">
      <h1 className="newthread-title">
        What should we build in <span>{projectName}</span>?
      </h1>
      <div className="newthread-composer">
        <ComposerView backend={backend} driver={driver} resetKey={`pending:${projectId}`} modelsRefreshKey={modelsRefreshKey} />
      </div>
      <div className="newthread-workspace">
        {branchError ? (
          <span className="workspace-hint" title={branchError}>Not a Git repository</span>
        ) : (
          <>
            <MenuSelect
              label="Workspace"
              title="Choose where this session works"
              value={mode}
              display={modeOptions.find((o) => o.id === mode)?.label ?? "Workspace"}
              options={modeOptions}
              onPick={pickMode}
            />
            {mode === "new" && branches.length > 0 && (
              <MenuSelect
                label="Base branch"
                title="Choose the branch this session starts from"
                value={workspace.baseBranch ?? branches[0].name}
                display={branches.find((item) => item.name === workspace.baseBranch)?.label ?? "Choose base branch"}
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
            )}
            {mode === "previous" && selectedCandidate && (
              <MenuSelect
                label="Reuse worktree"
                title="Pick which earlier session worktree to continue in"
                value={selectedCandidate.sessionId}
                display={selectedCandidate.title}
                options={candidates.map((c) => ({
                  id: c.sessionId,
                  label: c.title,
                  hint: c.worktreePath,
                  description: c.branch ?? undefined
                }))}
                onPick={(sessionId) => {
                  const picked = candidates.find((c) => c.sessionId === sessionId);
                  if (picked) store.setPendingWorkspace({ reuseWorktreePath: picked.worktreePath });
                }}
              />
            )}
          </>
        )}
      </div>
      <div className="harness-row" role="group" aria-label="Agentic harness">
        {HARNESS.map((h) => (
          <button
            key={h.id}
            className={`harness-btn ${h.id}${h.id === driver ? " active" : ""}`}
            onClick={() => onDriverChange(h.id)}
            aria-pressed={h.id === driver}
            title={`Use ${h.label}`}
          >
            <DriverIcon driver={h.id} size={14} />
            {h.label}
          </button>
        ))}
      </div>
    </div>
  );
}
