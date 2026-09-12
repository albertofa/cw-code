import { useEffect, useState } from "react";
import { GitBranch, GitFork } from "lucide-react";
import { useAppStore } from "../stores/appStore.js";
import type { DriverName, GitBranchInfo } from "../cw.js";
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
        <label className="worktree-toggle" title="Create an isolated Git worktree and branch for this session">
          <input
            type="checkbox"
            checked={workspace.useWorktree !== false}
            onChange={(event) => store.setPendingWorkspace({ useWorktree: event.target.checked })}
          />
          <GitFork size={13} />
          Isolated worktree
        </label>
        {workspace.useWorktree !== false && branches.length > 0 && (
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
        {branchError && <span className="workspace-hint" title={branchError}>Not a Git repository</span>}
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
