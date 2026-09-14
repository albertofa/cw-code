import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Gauge, GitBranch, RefreshCw, Sparkles, Star, X, XCircle } from "lucide-react";
import type { AppSettings, DriverName, EffortLevel, ModelOption, SourceControlHealth, WorktreePruneSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { useNotifs } from "./Notifications.js";
import { MenuSelect } from "./MenuSelect.js";
import { DriverIcon } from "./DriverIcon.js";

// Must match CLAUDE_CURATED_MODELS in apps/desktop/src/main/providers/claude/ClaudeCliDriver.ts.
// Main drops unknown ids on save, so keep this list in sync with the driver.
const CURATED_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

const HARNESSES: Array<{ id: DriverName; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "codex", label: "Codex" }
];

const EFFORTS: Array<{ id: EffortLevel; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" }
];

type Category = "general" | "sourceControl" | "harnesses";
type Harness = DriverName;

export function SettingsModal({
  initialHarness = "claude",
  onClose
}: {
  initialHarness?: Harness;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("harnesses");
  const [harness, setHarness] = useState<Harness>(initialHarness);
  const [harnessChecks, setHarnessChecks] = useState<Array<{ binary: DriverName; available: boolean }> | null>(null);
  const [harnessChecksError, setHarnessChecksError] = useState<string | null>(null);
  const [titleModels, setTitleModels] = useState<ModelOption[] | null>(null);
  const [titleModelsError, setTitleModelsError] = useState<string | null>(null);
  const [health, setHealth] = useState<SourceControlHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [projectAccount, setProjectAccount] = useState("");
  const [gitUserName, setGitUserName] = useState("");
  const [gitUserEmail, setGitUserEmail] = useState("");
  const [pruneBusy, setPruneBusy] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pruneSummary, setPruneSummary] = useState<WorktreePruneSummary | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const activeProject = useAppStore((state) => state.projects.find((project) => project.id === state.activeProjectId));

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void window.cw
      .getSettings()
      .then((s) => setDraft(s))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load settings"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setCategory("harnesses");
    setHarness(initialHarness);
  }, [initialHarness]);

  useEffect(() => {
    setProjectAccount(activeProject?.githubAccount ? `${activeProject.githubAccount.host}\t${activeProject.githubAccount.login}` : "");
  }, [activeProject?.id, activeProject?.githubAccount?.host, activeProject?.githubAccount?.login]);

  const loadSourceControlHealth = useCallback(() => {
    setHealthLoading(true);
    void window.cw.getSourceControlHealth(activeProjectId ?? undefined)
      .then((next) => {
        setHealth(next);
        setGitUserName(next.repository.userName ?? "");
        setGitUserEmail(next.repository.userEmail ?? "");
      })
      .catch((error: Error) => setHealth({
        git: { path: "git", available: false, version: null, error: error.message },
        githubCli: { path: "gh", available: false, version: null, error: error.message },
        repository: { available: false, root: null, branch: null, remoteUrl: null, githubHost: null, githubRepository: null, userName: null, userEmail: null, error: error.message },
        github: { accounts: [], selectedAccount: null, selectionSource: "none", error: error.message },
        issues: [{ level: "error", message: error.message }]
      }))
      .finally(() => setHealthLoading(false));
  }, [activeProjectId]);

  useEffect(() => {
    if (category === "sourceControl") loadSourceControlHealth();
  }, [category, loadSourceControlHealth]);

  useEffect(() => {
    if (category !== "general") return;
    let cancelled = false;
    setHarnessChecks(null);
    setHarnessChecksError(null);
    void window.cw
      .checkVersions()
      .then((checks) => {
        if (!cancelled) setHarnessChecks(checks);
      })
      .catch((err: Error) => {
        if (!cancelled) setHarnessChecksError(err.message || "Could not check installed harnesses");
      });
    return () => {
      cancelled = true;
    };
  }, [category]);

  useEffect(() => {
    const driver = draft?.autoTitleDriver;
    if (category !== "general" || !driver) return;
    let cancelled = false;
    setTitleModels(null);
    setTitleModelsError(null);
    void window.cw
      .listModelsForHarness(driver)
      .then((list) => {
        if (!cancelled) setTitleModels(list);
      })
      .catch((err) => {
        if (!cancelled) setTitleModelsError(err instanceof Error ? err.message : "Could not load models");
      });
    return () => {
      cancelled = true;
    };
  }, [category, draft?.autoTitleDriver]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<AppSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const setCustom = (patch: Partial<{ id: string; name: string }>) => {
    setDraft((d) => (d ? { ...d, claudeCustomModel: { ...d.claudeCustomModel, ...patch } } : d));
  };

  const customId = draft?.claudeCustomModel.id.trim() ?? "";
  const customName = draft?.claudeCustomModel.name.trim() ?? "";
  const savedTitleModel = draft?.autoTitleModel.trim() ?? "";
  const savedTitleModelMissing = savedTitleModel !== "" && !(titleModels ?? []).some((model) => model.id === savedTitleModel);

  const removeCustom = () => {
    if (!draft) return;
    set({
      claudeCustomModel: { id: "", name: "" },
      ...(draft.claudeDefaultModel === customId ? { claudeDefaultModel: "" } : {})
    });
  };

  const toggleModel = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.claudeEnabledModels.includes(id);
      return {
        ...d,
        claudeEnabledModels: has ? d.claudeEnabledModels.filter((m) => m !== id) : [...d.claudeEnabledModels, id],
        ...(has && d.claudeDefaultModel === id ? { claudeDefaultModel: "" } : {})
      };
    });
  };

  const starModel = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.claudeDefaultModel === id) return { ...d, claudeDefaultModel: "" };
      return {
        ...d,
        claudeDefaultModel: id,
        claudeEnabledModels: d.claudeEnabledModels.includes(id)
          ? d.claudeEnabledModels
          : [...d.claudeEnabledModels, id]
      };
    });
  };

  const starButton = (id: string, label: string) => {
    const active = draft?.claudeDefaultModel === id;
    return (
      <button
        className={`settings-star${active ? " active" : ""}`}
        title={active ? `Default model (${label}) — click to clear` : `Set ${label} as default`}
        aria-label={active ? `Default model (${label}) — click to clear` : `Set ${label} as default`}
        aria-pressed={active}
        onClick={() => starModel(id)}
      >
        <Star size={14} fill={active ? "currentColor" : "none"} />
      </button>
    );
  };

  const onSave = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const store = useAppStore.getState();
      await store.saveSettings(draft);
      if (activeProjectId) {
        const [host, login] = projectAccount.split("\t");
        await store.setProjectGitHubAccount(activeProjectId, host && login ? { host, login } : null);
        if (health?.repository.available && (gitUserName.trim() !== (health.repository.userName ?? "") || gitUserEmail.trim() !== (health.repository.userEmail ?? ""))) {
          await window.cw.setRepositoryGitIdentity(activeProjectId, gitUserName, gitUserEmail);
        }
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save settings";
      setSaveError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not save settings", message });
    } finally {
      setSaving(false);
    }
  };

  const pickHarness = (h: Harness) => {
    setCategory("harnesses");
    setHarness(h);
  };

  const runPrune = async () => {
    setPruneBusy(true);
    setPruneError(null);
    try {
      const summary = await window.cw.pruneStaleWorktrees();
      setPruneSummary(summary);
      setConfirmPrune(false);
      if (summary.failed > 0) {
        useNotifs.getState().push({
          kind: "error",
          title: "Prune finished with failures",
          message: summary.errors[0] ?? `${summary.failed} worktrees could not be removed`
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not prune worktrees";
      setPruneError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not prune worktrees", message });
    } finally {
      setPruneBusy(false);
    }
  };

  const modelsSection = draft && (
    <section className="settings-section">
      <h3>Models</h3>
      <span className="settings-hint">Star a model to make it the default, used when a session has no model set.</span>
      <div className="settings-checks">
        {CURATED_MODELS.map((m) => (
          <div key={m.id} className="settings-check">
            <input
              type="checkbox"
              aria-label={`Enable ${m.label}`}
              checked={draft.claudeEnabledModels.includes(m.id)}
              onChange={() => toggleModel(m.id)}
            />
            {starButton(m.id, m.label)}
            <span>
              {m.label} <span className="settings-id">{m.id}</span>
            </span>
          </div>
        ))}
        {customId && (
          <div className="settings-check" key="__custom">
            <span className="settings-tag">custom</span>
            {starButton(customId, customName || customId)}
            <span>
              {customName || customId}
              {customName && <span className="settings-id"> {customId}</span>}
            </span>
            <button className="btn settings-remove" onClick={removeCustom}>
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="settings-custom">
        <label className="settings-row">
          <span className="settings-label">Custom model ID</span>
          <input
            className="field"
            value={draft.claudeCustomModel.id}
            placeholder="provider/model"
            onChange={(e) => setCustom({ id: e.target.value })}
          />
        </label>
        <label className="settings-row">
          <span className="settings-label">Display name</span>
          <input
            className="field"
            value={draft.claudeCustomModel.name}
            placeholder="My model"
            onChange={(e) => setCustom({ name: e.target.value })}
          />
        </label>
      </div>
    </section>
  );

  const claudeFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the Claude binary used by this instance.</span>
        <input
          className="field"
          value={draft.claudeBinaryPath}
          placeholder="claude"
          onChange={(e) => set({ claudeBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed on session start.</span>
        <input
          className="field"
          value={draft.claudeExtraArgs}
          placeholder="--dangerously-skip-permissions"
          onChange={(e) => set({ claudeExtraArgs: e.target.value })}
        />
      </label>
      {modelsSection}
    </>
  );

  const opencodeFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the OpenCode binary used by this instance.</span>
        <input
          className="field"
          value={draft.opencodeBinaryPath}
          placeholder="opencode"
          onChange={(e) => set({ opencodeBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed on session start.</span>
        <input
          className="field"
          value={draft.opencodeExtraArgs}
          placeholder="--dangerously-skip-permissions"
          onChange={(e) => set({ opencodeExtraArgs: e.target.value })}
        />
      </label>
    </>
  );

  const codexFields = draft && (
    <>
      <label className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Path to the Codex binary used by this instance.</span>
        <input
          className="field"
          value={draft.codexBinaryPath}
          placeholder="codex"
          onChange={(e) => set({ codexBinaryPath: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Launch arguments</span>
        <span className="settings-hint">Additional CLI arguments passed to the app server on startup.</span>
        <input
          className="field"
          value={draft.codexExtraArgs}
          placeholder="--enable feature"
          onChange={(e) => set({ codexExtraArgs: e.target.value })}
        />
      </label>
    </>
  );

  const generalFields = draft && (
    <section className="settings-section">
      <h3>Session titles</h3>
      <span className="settings-hint">Generate a short title from the first message of a new session, replacing the placeholder title.</span>
      <div className="settings-card">
        <label className="settings-card-head">
          <span className="settings-card-text">
            <span className="settings-label"><Sparkles size={13} aria-hidden="true" /> Generate titles automatically</span>
            <span className="settings-hint">Runs a one-off title request with the harness, model and effort below.</span>
          </span>
          <span className="settings-switch">
            <input type="checkbox" checked={draft.autoTitleEnabled} onChange={(e) => set({ autoTitleEnabled: e.target.checked })} aria-label="Generate titles automatically" />
            <span className="track" aria-hidden="true" />
          </span>
        </label>
        <div className="settings-card-controls">
          <div className="settings-card-field">
            <span>Harness</span>
            <MenuSelect
              label="Title harness"
              title="Harness used for the title request"
              direction="down"
              value={draft.autoTitleDriver}
              display={HARNESSES.find((h) => h.id === draft.autoTitleDriver)?.label ?? draft.autoTitleDriver}
              icon={<DriverIcon driver={draft.autoTitleDriver} size={13} />}
              options={HARNESSES.map((h) => {
                const unavailable = harnessChecks?.find((check) => check.binary === h.id)?.available === false;
                return {
                  id: h.id,
                  label: h.label,
                  hint: h.label,
                  description: unavailable ? "Not installed" : undefined,
                  disabled: unavailable,
                  icon: <DriverIcon driver={h.id} size={13} />
                };
              })}
              onPick={(id) => set({ autoTitleDriver: id as DriverName })}
            />
          </div>
          <div className="settings-card-field">
            <span>Model</span>
            <MenuSelect
              label="Title model"
              title="Model used for the title request"
              direction="down"
              value={draft.autoTitleModel}
              display={titleModels?.find((model) => model.id === draft.autoTitleModel)?.label ?? (draft.autoTitleModel === "" ? "Default" : draft.autoTitleModel)}
              icon={<Bot size={13} aria-hidden="true" />}
              options={[
                { id: "", label: "Default", hint: "Default" },
                ...(titleModels?.map((model) => ({ id: model.id, label: model.label, hint: model.id })) ?? []),
                ...(savedTitleModelMissing ? [{ id: savedTitleModel, label: `${savedTitleModel} (saved)`, hint: savedTitleModel }] : [])
              ]}
              onPick={(id) => set({ autoTitleModel: id })}
              searchable
              searchPlaceholder="Filter models…"
            />
          </div>
          <div className="settings-card-field">
            <span>Effort</span>
            <MenuSelect
              label="Title effort"
              title="Reasoning effort used for the title request"
              direction="down"
              value={draft.autoTitleEffort}
              display={EFFORTS.find((effort) => effort.id === draft.autoTitleEffort)?.label ?? draft.autoTitleEffort}
              icon={<Gauge size={13} aria-hidden="true" />}
              options={EFFORTS.map((effort) => ({ id: effort.id, label: effort.label, hint: effort.label }))}
              onPick={(id) => set({ autoTitleEffort: id as EffortLevel })}
            />
          </div>
        </div>
        <span className="settings-hint settings-card-foot">
          {harnessChecksError
            ? harnessChecksError
            : harnessChecks === null
              ? "Checking installed harnesses…"
              : titleModelsError
                ? titleModelsError
                : titleModels === null
                  ? "Loading models…"
                  : "Unavailable harnesses are not installed or failed '--version'. Models are fetched from the selected harness."}
        </span>
      </div>
    </section>
  );

  const sourceControlFields = draft && (
    <>
      <section className="settings-section">
        <div className="settings-section-title">
          <h3>Tools and refresh</h3>
          <button className="btn settings-recheck" onClick={loadSourceControlHealth} disabled={healthLoading}>
            <RefreshCw size={12} /> {healthLoading ? "Checking…" : "Recheck"}
          </button>
        </div>
        <label className="settings-row">
          <span className="settings-label">Git executable</span>
          <span className="settings-hint">Used for status, branches, diffs, identity, and worktrees.</span>
          <input className="field" value={draft.gitBinaryPath} placeholder="git" onChange={(e) => set({ gitBinaryPath: e.target.value })} />
        </label>
        <label className="settings-row">
          <span className="settings-label">GitHub CLI executable</span>
          <span className="settings-hint">Used for account discovery and pull-request status.</span>
          <input className="field" value={draft.githubCliBinaryPath} placeholder="gh" onChange={(e) => set({ githubCliBinaryPath: e.target.value })} />
        </label>
        <label className="settings-row">
          <span className="settings-label">Automatic refresh</span>
          <span className="settings-hint">Poll Git status and GitHub PR checks in the active project. Minimum 5 seconds.</span>
          <span className="settings-number-field">
            <input className="field" type="number" min={5} max={3600} value={draft.sourceControlRefreshIntervalSeconds} onChange={(e) => set({ sourceControlRefreshIntervalSeconds: Number(e.target.value) })} />
            <span>seconds</span>
          </span>
        </label>
        <label className="settings-row">
          <span className="settings-label">New-session worktrees</span>
          <span className="settings-hint">Create an isolated branch and worktree for every new Git session by default.</span>
          <input className="settings-toggle" type="checkbox" checked={draft.defaultUseWorktree} onChange={(e) => set({ defaultUseWorktree: e.target.checked })} />
        </label>
      </section>

      <section className="settings-section">
        <h3>Worktree maintenance</h3>
        <span className="settings-hint">
          Removes worktree directories that no session references anymore, along with their registration. Sessions are never touched.
        </span>
        {!confirmPrune ? (
          <button
            className="btn"
            disabled={pruneBusy}
            onClick={() => {
              setConfirmPrune(true);
              setPruneSummary(null);
              setPruneError(null);
            }}
          >
            Prune stale worktrees…
          </button>
        ) : (
          <div className="settings-prune-confirm">
            <span>Scan for stale worktree directories and remove them now?</span>
            <button className="btn btn-primary" onClick={() => void runPrune()} disabled={pruneBusy}>
              {pruneBusy ? "Pruning…" : "Remove"}
            </button>
            <button className="btn" onClick={() => setConfirmPrune(false)} disabled={pruneBusy}>
              Cancel
            </button>
          </div>
        )}
        {pruneSummary && (
          <div className="settings-prune-summary">
            {pruneSummary.removed === 0 && pruneSummary.failed === 0 && pruneSummary.skipped === 0 && pruneSummary.keptDirty.length === 0
              ? "No stale worktrees found."
              : `Removed ${pruneSummary.removed} of ${pruneSummary.scanned} scanned.`}
            {pruneSummary.skipped > 0 && (
              <div>
                Skipped {pruneSummary.skipped} {pruneSummary.skipped === 1 ? "directory" : "directories"} that are not git worktrees.
              </div>
            )}
            {pruneSummary.keptDirty.length > 0 && (
              <div>
                Kept {pruneSummary.keptDirty.length} {pruneSummary.keptDirty.length === 1 ? "worktree" : "worktrees"} with uncommitted changes:
                <div className="settings-prune-paths">{pruneSummary.keptDirty.join("\n")}</div>
              </div>
            )}
            {pruneSummary.failed > 0 && <div className="settings-error">{pruneSummary.errors.join("\n")}</div>}
          </div>
        )}
        {pruneError && <div className="settings-error">{pruneError}</div>}
      </section>

      <section className="settings-section settings-health">
        <h3>Health</h3>
        {!health && healthLoading && <div className="side-empty">Inspecting source control…</div>}
        {health && (
          <>
            <div className="source-health-grid">
              <div className={`source-health-item ${health.git.available ? "ok" : "error"}`}>
                {health.git.available ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span><b>Git</b><small>{health.git.version ?? health.git.error ?? "Unavailable"}</small></span>
              </div>
              <div className={`source-health-item ${health.githubCli.available ? "ok" : "error"}`}>
                {health.githubCli.available ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span><b>GitHub CLI</b><small>{health.githubCli.version ?? health.githubCli.error ?? "Unavailable"}</small></span>
              </div>
            </div>
            {health.issues.map((issue, index) => <div key={`${issue.level}:${index}`} className={`source-health-issue ${issue.level}`}><AlertTriangle size={13} /> {issue.message}</div>)}
            {health.issues.length === 0 && <div className="source-health-ok"><CheckCircle2 size={13} /> Source control is ready.</div>}
          </>
        )}
      </section>

      {activeProjectId && health?.repository.available && (
        <section className="settings-section">
          <h3>{activeProject?.name ?? "Current project"}</h3>
          <div className="settings-repo-summary">
            <GitBranch size={14} />
            <span><b>{health.repository.githubRepository ?? health.repository.root}</b><small>{health.repository.remoteUrl ?? "No remote"}</small></span>
          </div>
          <label className="settings-row">
            <span className="settings-label">GitHub account</span>
            <span className="settings-hint">Auto discovery currently resolves {health.github.selectedAccount ? `@${health.github.selectedAccount}` : "no account"}{health.github.selectionSource !== "none" ? ` by ${health.github.selectionSource}` : ""}.</span>
            <select className="field" value={projectAccount} onChange={(e) => setProjectAccount(e.target.value)}>
              <option value="">Automatic (recommended)</option>
              {activeProject?.githubAccount && !health.github.accounts.some((account) => account.host === activeProject.githubAccount?.host && account.login === activeProject.githubAccount?.login) && (
                <option value={`${activeProject.githubAccount.host}\t${activeProject.githubAccount.login}`} disabled>{activeProject.githubAccount.login} · {activeProject.githubAccount.host} · unavailable</option>
              )}
              {health.github.accounts.map((account) => (
                <option key={`${account.host}:${account.login}`} value={`${account.host}\t${account.login}`} disabled={!account.authenticated}>
                  {account.login} · {account.host}{account.active ? " · active" : ""}{account.hasRepositoryAccess === false ? " · no access" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span className="settings-label">Commit author name</span>
            <span className="settings-hint">Stored in this repository’s local Git config.</span>
            <input className="field" value={gitUserName} placeholder="Your name" onChange={(e) => setGitUserName(e.target.value)} />
          </label>
          <label className="settings-row">
            <span className="settings-label">Commit author email</span>
            <span className="settings-hint">Use the email associated with this project’s GitHub account.</span>
            <input className="field" type="email" value={gitUserEmail} placeholder="you@example.com" onChange={(e) => setGitUserEmail(e.target.value)} />
          </label>
        </section>
      )}
      {!activeProjectId && <div className="side-empty">Select a project to configure its repository and GitHub account.</div>}
    </>
  );

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>Settings</span>
          <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings categories">
            <button
              className={`settings-nav-item${category === "general" ? " active" : ""}`}
              onClick={() => setCategory("general")}
              aria-current={category === "general"}
            >
              General
            </button>
            <button
              className={`settings-nav-item${category === "sourceControl" ? " active" : ""}`}
              onClick={() => setCategory("sourceControl")}
              aria-current={category === "sourceControl"}
            >
              Source Control
            </button>
            <div className="settings-nav-group">Harnesses</div>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "claude" ? " active" : ""}`}
              onClick={() => pickHarness("claude")}
              aria-current={category === "harnesses" && harness === "claude"}
            >
              <DriverIcon driver="claude" size={14} /> Claude Code
            </button>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "opencode" ? " active" : ""}`}
              onClick={() => pickHarness("opencode")}
              aria-current={category === "harnesses" && harness === "opencode"}
            >
              <DriverIcon driver="opencode" size={14} /> OpenCode
            </button>
            <button
              className={`settings-nav-item sub${category === "harnesses" && harness === "codex" ? " active" : ""}`}
              onClick={() => pickHarness("codex")}
              aria-current={category === "harnesses" && harness === "codex"}
            >
              <DriverIcon driver="codex" size={14} /> Codex
            </button>
          </nav>
          <div className="settings-content">
            {loading && <div className="side-empty">Loading settings…</div>}
            {!loading && loadError && (
              <>
                <div className="settings-error">{loadError}</div>
                <div>
                  <button className="btn" onClick={load}>
                    Retry
                  </button>
                </div>
              </>
            )}
            {!loading && !loadError && draft && category === "general" && generalFields}
            {!loading && !loadError && draft && category === "sourceControl" && sourceControlFields}
            {!loading && !loadError && draft && category === "harnesses" && (
              <>
                <div className="settings-section">
                  {harness === "claude" ? claudeFields : harness === "codex" ? codexFields : opencodeFields}
                </div>
              </>
            )}
            {saveError && <div className="settings-error">{saveError}</div>}
          </div>
        </div>
        <div className="settings-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={!draft || loading || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
