import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Copy, FolderPlus, Gauge, GitBranch, RefreshCw, Sparkles, XCircle } from "lucide-react";
import type { PanelId } from "@cw-code/contracts";
import type { AppSettings, DriverName, ModelOption, SourceControlHealth, WorktreePruneSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePanelStore } from "../stores/panelStore.js";
import { accountKey, useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { BinaryPicker } from "./BinaryPicker.js";
import { useConfirm } from "./ConfirmDialog.js";
import { DriverIcon } from "./DriverIcon.js";
import { HarnessSettings } from "./HarnessSettings.js";
import { MenuSelect } from "./MenuSelect.js";
import { EFFORTS } from "./modelMenus.js";
import { useNotifs } from "./Notifications.js";
import { shortenHome } from "./pathDisplay.js";
import { PrWorkflowSettings } from "./PrWorkflowSettings.js";
import {
  copySetting,
  HARNESS_IDS,
  HARNESS_NAMES,
  navIdOf,
  navLabel,
  sameValue,
  sectionSummary,
  SETTING_KEYS,
  unsavedSectionLabels,
  type SettingsSection
} from "./settingsSections.js";
import { TOOL_TABS } from "./toolTabs.js";
import { UpdatesSettings } from "./UpdatesSettings.js";
import { errorMessage } from "./errorMessage.js";
import { visibleLayerOpen } from "./openLayer.js";
import appIcon from "../assets/console-c.svg";
import { version as appVersion, description as appDescription } from "../../../../package.json";
import { SettingsGroup, SettingsPageHead, SettingsRow, SettingsSwitch, type BinaryPickHandler } from "./SettingsLayout.js";
import "./settingsPage.css";

const PANEL_OPTIONS: Array<{ id: PanelId; label: string }> = [
  { id: "main", label: "Main panel" },
  { id: "right", label: "Right panel" },
  { id: "bottom", label: "Bottom panel" }
];

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "number", "url", "tel", "password"]);

function GeneralSettings() {
  const draft = useSettingsDraftStore((s) => s.draft);
  const set = useSettingsDraftStore((s) => s.set);
  const checks = useSettingsDraftStore((s) => s.harnessChecks);
  const checksError = useSettingsDraftStore((s) => s.harnessChecksError);
  const tabAutoLocation = usePanelStore((s) => s.autoLocation);
  const setTabAutoLocation = usePanelStore((s) => s.setAutoLocation);
  const [titleModels, setTitleModels] = useState<ModelOption[] | null>(null);
  const [titleModelsError, setTitleModelsError] = useState<string | null>(null);
  const driver = draft?.autoTitleDriver;

  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    setTitleModels(null);
    setTitleModelsError(null);
    window.cw
      .listModelsForHarness(driver)
      .then((list) => {
        if (!cancelled) setTitleModels(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setTitleModelsError(errorMessage(err) || "Could not load models");
      });
    return () => {
      cancelled = true;
    };
  }, [driver]);

  if (!draft) return null;
  const savedTitleModel = draft.autoTitleModel.trim();
  const savedTitleModelMissing = savedTitleModel !== "" && !(titleModels ?? []).some((model) => model.id === savedTitleModel);
  const titleStatus = checksError ?? titleModelsError;

  return (
    <>
      <SettingsPageHead title="General" description="Session titles, workspace tabs and how long sessions stay on hold." />
      <SettingsGroup title="Session titles">
        <div className="sp-card">
          <div className="sp-card-head">
            <label className="sp-lab" htmlFor="sp-auto-title">
              <span className="sp-lab-icon">
                <Sparkles size={13} aria-hidden="true" /> Generate titles automatically
              </span>
              <small>Titles a new session from its first message with the harness, model and effort below.</small>
            </label>
            <SettingsSwitch
              id="sp-auto-title"
              checked={draft.autoTitleEnabled}
              onChange={(next) => set({ autoTitleEnabled: next })}
              label="Generate titles automatically"
            />
          </div>
          <div className="sp-card-grid">
            <div className="sp-field">
              <span>Harness</span>
              <MenuSelect
                label="Title harness"
                title="Harness used for the title request"
                direction="down"
                value={draft.autoTitleDriver}
                display={HARNESS_NAMES[draft.autoTitleDriver]}
                icon={<DriverIcon driver={draft.autoTitleDriver} size={13} />}
                options={HARNESS_IDS.map((id) => {
                  const unavailable = checks?.find((check) => check.binary === id)?.available === false;
                  return {
                    id,
                    label: HARNESS_NAMES[id],
                    hint: HARNESS_NAMES[id],
                    description: unavailable ? "Not installed" : undefined,
                    disabled: unavailable,
                    icon: <DriverIcon driver={id} size={13} />
                  };
                })}
                onPick={(id) => {
                  const next = HARNESS_IDS.find((h) => h === id);
                  if (next) set({ autoTitleDriver: next });
                }}
              />
            </div>
            <div className="sp-field">
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
            <div className="sp-field">
              <span>Effort</span>
              <MenuSelect
                label="Title effort"
                title="Reasoning effort used for the title request"
                direction="down"
                value={draft.autoTitleEffort}
                display={EFFORTS.find((effort) => effort.id === draft.autoTitleEffort)?.label ?? draft.autoTitleEffort}
                icon={<Gauge size={13} aria-hidden="true" />}
                options={EFFORTS.map((effort) => ({ id: effort.id, label: effort.label, hint: effort.label }))}
                onPick={(id) => {
                  const next = EFFORTS.find((effort) => effort.id === id);
                  if (next) set({ autoTitleEffort: next.id });
                }}
              />
            </div>
          </div>
          <div className={`sp-card-foot${titleStatus ? " bad" : ""}`} role={titleStatus ? "alert" : undefined}>
            {titleStatus ??
              (checks === null
                ? "Checking installed harnesses…"
                : titleModels === null
                  ? "Loading models…"
                  : "Harnesses that aren't installed or fail '--version' can't be picked. Models come from the selected harness.")}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Workspace tabs">
        <p className="sp-hint">Where each right-rail tool opens. This applies immediately; you can still drag tabs between panels at any time.</p>
        {TOOL_TABS.map((tab) => (
          <SettingsRow
            key={tab.id}
            htmlFor={`sp-tab-${tab.id}`}
            label={
              <span className="sp-lab-icon">
                <tab.Icon size={13} aria-hidden="true" /> {tab.title}
              </span>
            }
          >
            <select
              id={`sp-tab-${tab.id}`}
              className="field sp-select"
              value={tabAutoLocation[tab.id]}
              onChange={(e) => {
                const panel = PANEL_OPTIONS.find((option) => option.id === e.target.value);
                if (panel) setTabAutoLocation(tab.id, panel.id);
              }}
            >
              {PANEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="Sessions">
        <SettingsRow label="Return holding sessions automatically" hint="Moves a session from Holding back to Idle after the delay." htmlFor="sp-holding-auto">
          <SettingsSwitch
            id="sp-holding-auto"
            checked={draft.holdingAutoExpireEnabled}
            onChange={(next) => set({ holdingAutoExpireEnabled: next })}
            label="Return holding sessions automatically"
          />
        </SettingsRow>
        <SettingsRow label="Delay" hint="1 to 168 hours." htmlFor="sp-holding-hours">
          <span className="sp-number">
            <input
              id="sp-holding-hours"
              className="field"
              type="number"
              min={1}
              max={168}
              value={draft.holdingHours}
              disabled={!draft.holdingAutoExpireEnabled}
              onChange={(e) => set({ holdingHours: Number(e.target.value) })}
            />
            <span>hours</span>
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="About">
        <div className="sp-about">
          <img src={appIcon} alt="" aria-hidden="true" draggable={false} />
          <div>
            <strong>cw-code</strong>
            <span>Version {appVersion} · MIT License</span>
          </div>
        </div>
        <p className="sp-hint">{appDescription} Uses your installed CLIs and their own authentication.</p>
      </SettingsGroup>
    </>
  );
}

function healthFailure(message: string): SourceControlHealth {
  return {
    git: { path: "git", available: false, version: null, error: message },
    githubCli: { path: "gh", available: false, version: null, error: message },
    repository: { available: false, root: null, branch: null, remoteUrl: null, githubHost: null, githubRepository: null, userName: null, userEmail: null, error: message },
    github: { accounts: [], selectedAccount: null, selectionSource: "none", error: message },
    issues: [{ level: "error", message }]
  };
}

function SourceControlSettings({ onPickBinary }: { onPickBinary: BinaryPickHandler }) {
  const draft = useSettingsDraftStore((s) => s.draft);
  const set = useSettingsDraftStore((s) => s.set);
  const repoDraft = useSettingsDraftStore((s) => s.repoDraft);
  const setRepo = useSettingsDraftStore((s) => s.setRepo);
  const projects = useAppStore((s) => s.projects);
  const homeDir = useAppStore((s) => s.homeDir);
  const addProject = useAppStore((s) => s.addProject);
  const { confirm, dialog } = useConfirm();
  const [configProjectId, setConfigProjectId] = useState<string | null>(() => {
    const state = useAppStore.getState();
    return (
      useSettingsDraftStore.getState().repoSaved?.projectId ??
      state.activeProjectId ??
      state.projects[0]?.id ??
      null
    );
  });
  const [health, setHealth] = useState<SourceControlHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pruneSummary, setPruneSummary] = useState<WorktreePruneSummary | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const configProject = projects.find((project) => project.id === configProjectId) ?? projects[0];
  const configId = configProject?.id ?? null;
  const healthRequest = useRef(0);

  useEffect(() => {
    void useAppStore.getState().ensureHomeDir().catch(() => undefined);
  }, []);

  const loadHealth = useCallback(() => {
    const request = ++healthRequest.current;
    const current = () => request === healthRequest.current;
    setHealthLoading(true);
    window.cw
      .getSourceControlHealth(configId ?? undefined)
      .then((next) => {
        if (!current()) return;
        setHealth(next);
        const store = useSettingsDraftStore.getState();
        const keepEdits = store.repoSaved?.projectId === configId && !sameValue(store.repoDraft, store.repoSaved);
        if (keepEdits) return;
        const project = useAppStore.getState().projects.find((p) => p.id === configId);
        store.setRepoBaseline(
          project
            ? {
                projectId: project.id,
                account: accountKey(project.githubAccount),
                userName: next.repository.userName ?? "",
                userEmail: next.repository.userEmail ?? "",
                identityEditable: next.repository.available
              }
            : null
        );
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setHealth(healthFailure(errorMessage(err)));
      })
      .finally(() => {
        if (current()) setHealthLoading(false);
      });
  }, [configId]);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const switchProject = async (id: string) => {
    if (id === configId) return;
    const store = useSettingsDraftStore.getState();
    if (!sameValue(store.repoDraft, store.repoSaved)) {
      const ok = await confirm({
        title: "Discard repository changes?",
        message: `Your unsaved account and commit author changes for ${configProject?.name ?? "this project"} will be lost.`,
        danger: true,
        confirmLabel: "Discard"
      });
      if (!ok) return;
    }
    store.setRepoBaseline(null);
    setHealth(null);
    setConfigProjectId(id);
  };

  const addFolder = () => {
    setAdding(true);
    window.cw
      .pickProjectDir()
      .then((dir) => (dir ? addProject(dir) : undefined))
      .catch((err: unknown) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: errorMessage(err) });
      })
      .finally(() => setAdding(false));
  };

  const copyPath = (id: string, path: string) => {
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
      })
      .catch((err: unknown) => {
        useNotifs.getState().push({ kind: "error", title: "Could not copy the path", message: errorMessage(err) });
      });
  };

  const runPrune = async () => {
    setPruneBusy(true);
    setPruneError(null);
    try {
      const summary = await window.cw.pruneStaleWorktrees();
      useAppStore.getState().clearSessionWorktrees(summary.clearedSessionIds);
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
      const message = errorMessage(err) || "Could not prune worktrees";
      setPruneError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not prune worktrees", message });
    } finally {
      setPruneBusy(false);
    }
  };

  if (!draft) return null;
  const repoReady = repoDraft !== null && repoDraft.projectId === configId && health?.repository.available === true;

  return (
    <>
      <SettingsPageHead title="Source control" description="Git and GitHub CLI executables, refresh, projects, and each repository's account and commit author." />
      <SettingsGroup
        title="Tools and refresh"
        action={
          <button type="button" className="btn sp-btn-sm" onClick={loadHealth} disabled={healthLoading}>
            <RefreshCw size={12} aria-hidden="true" /> {healthLoading ? "Checking…" : "Recheck"}
          </button>
        }
      >
        <div className="sp-stack">
          <div className="sp-lab">
            Git executable
            <small>Used for status, branches, diffs, identity and worktrees. Picking one applies immediately.</small>
          </div>
          <BinaryPicker
            key="git"
            binary="git"
            value={draft.gitBinaryPath}
            onPick={(path) => onPickBinary({ gitBinaryPath: path })}
            autoDiscoverKey={`sourceControl:git:${draft.gitBinaryPath}`}
          />
        </div>
        <div className="sp-stack">
          <div className="sp-lab">
            GitHub CLI executable
            <small>Used for account discovery and pull-request status. Picking one applies immediately.</small>
          </div>
          <BinaryPicker
            key="gh"
            binary="gh"
            value={draft.githubCliBinaryPath}
            onPick={(path) => onPickBinary({ githubCliBinaryPath: path })}
            autoDiscoverKey={`sourceControl:gh:${draft.githubCliBinaryPath}`}
          />
        </div>
        <SettingsRow label="Automatic refresh" hint="Polls Git status and GitHub PR checks for active sessions. Minimum 5 seconds." htmlFor="sp-sc-refresh">
          <span className="sp-number">
            <input
              id="sp-sc-refresh"
              className="field"
              type="number"
              min={5}
              max={3600}
              value={draft.sourceControlRefreshIntervalSeconds}
              onChange={(e) => set({ sourceControlRefreshIntervalSeconds: Number(e.target.value) })}
            />
            <span>seconds</span>
          </span>
        </SettingsRow>
        <SettingsRow label="New-session worktrees" hint="Create an isolated branch and worktree for every new Git session by default." htmlFor="sp-sc-worktree">
          <SettingsSwitch id="sp-sc-worktree" checked={draft.defaultUseWorktree} onChange={(next) => set({ defaultUseWorktree: next })} label="Create a worktree for new Git sessions by default" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Health">
        {!health && healthLoading && <p className="sp-hint">Inspecting source control…</p>}
        {health && (
          <>
            <div className="sp-health">
              <div className={`sp-health-item ${health.git.available ? "ok" : "bad"}`}>
                {health.git.available ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
                <span>
                  <b>Git</b>
                  <small>{health.git.version ?? health.git.error ?? "Unavailable"}</small>
                </span>
              </div>
              <div className={`sp-health-item ${health.githubCli.available ? "ok" : "bad"}`}>
                {health.githubCli.available ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
                <span>
                  <b>GitHub CLI</b>
                  <small>{health.githubCli.version ?? health.githubCli.error ?? "Unavailable"}</small>
                </span>
              </div>
            </div>
            {health.issues.map((issue, index) => (
              <div key={`${issue.level}:${index}`} className={`sp-issue ${issue.level}`} role={issue.level === "error" ? "alert" : undefined}>
                <AlertTriangle size={13} aria-hidden="true" /> {issue.message}
              </div>
            ))}
            {health.issues.length === 0 && (
              <div className="sp-issue ok">
                <CheckCircle2 size={13} aria-hidden="true" /> Source control is ready.
              </div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Projects"
        action={
          <button type="button" className="btn sp-btn-sm" onClick={addFolder} disabled={adding}>
            <FolderPlus size={12} aria-hidden="true" /> {adding ? "Adding…" : "Add project…"}
          </button>
        }
      >
        {projects.length === 0 ? (
          <p className="sp-hint">No projects yet. Add a folder to start sessions in it.</p>
        ) : (
          <ul className="sp-list" aria-label="Projects">
            {projects.map((project) => (
              <li key={project.id} className="sp-list-row">
                <span className="sp-list-main">
                  <b>{project.name}</b>
                  <span className="sp-mono" title={project.rootPath}>
                    {shortenHome(project.rootPath, homeDir ?? undefined)}
                  </span>
                </span>
                <button type="button" className="btn sp-btn-sm" onClick={() => copyPath(project.id, project.rootPath)} aria-label={`Copy the path of ${project.name}`}>
                  <Copy size={12} aria-hidden="true" /> {copiedId === project.id ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {configProject && (
        <SettingsGroup title="Repository">
          <SettingsRow label="Project" hint="The account and commit author below apply to this project." htmlFor="sp-sc-project">
            <select id="sp-sc-project" className="field sp-select" value={configProject.id} onChange={(e) => void switchProject(e.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </SettingsRow>
          {!health && healthLoading && <p className="sp-hint">Inspecting repository…</p>}
          {health && !health.repository.available && (
            <p className="sp-hint" role="status">
              {health.repository.error ?? "This project is not a Git repository."}
            </p>
          )}
          {health?.repository.available && repoReady && (
            <>
              <div className="sp-repo">
                <GitBranch size={14} aria-hidden="true" />
                <span>
                  <b>{health.repository.githubRepository ?? health.repository.root}</b>
                  <small>{health.repository.remoteUrl ?? "No remote"}</small>
                </span>
              </div>
              <SettingsRow
                label="GitHub account"
                htmlFor="sp-sc-account"
                hint={`Automatic currently resolves ${health.github.selectedAccount ? `@${health.github.selectedAccount}` : "no account"}${health.github.selectionSource !== "none" ? ` by ${health.github.selectionSource}` : ""}.`}
              >
                <select id="sp-sc-account" className="field sp-select" value={repoDraft.account} onChange={(e) => setRepo({ account: e.target.value })}>
                  <option value="">Automatic (recommended)</option>
                  {configProject.githubAccount &&
                    !health.github.accounts.some((account) => account.host === configProject.githubAccount?.host && account.login === configProject.githubAccount?.login) && (
                      <option value={accountKey(configProject.githubAccount)} disabled>
                        {configProject.githubAccount.login} · {configProject.githubAccount.host} · unavailable
                      </option>
                    )}
                  {health.github.accounts.map((account) => (
                    <option key={`${account.host}:${account.login}`} value={accountKey(account)} disabled={!account.authenticated}>
                      {account.login} · {account.host}
                      {account.active ? " · active" : ""}
                      {account.hasRepositoryAccess === false ? " · no access" : ""}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsRow label="Commit author name" hint="Stored in this repository's local Git config." htmlFor="sp-sc-name">
                <input id="sp-sc-name" className="field" value={repoDraft.userName} placeholder="Your name" onChange={(e) => setRepo({ userName: e.target.value })} />
              </SettingsRow>
              <SettingsRow label="Commit author email" hint="Use the email tied to this project's GitHub account." htmlFor="sp-sc-email">
                <input
                  id="sp-sc-email"
                  className="field"
                  type="email"
                  value={repoDraft.userEmail}
                  placeholder="you@example.com"
                  onChange={(e) => setRepo({ userEmail: e.target.value })}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title="Worktree maintenance">
        <p className="sp-hint">Removes worktree directories that no session references anymore, along with their registration. Sessions are never touched.</p>
        {!confirmPrune ? (
          <div>
            <button
              type="button"
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
          </div>
        ) : (
          <div className="sp-inline-confirm">
            <span>Scan for stale worktree directories and remove them now?</span>
            <button type="button" className="btn btn-primary" onClick={() => void runPrune()} disabled={pruneBusy}>
              {pruneBusy ? "Pruning…" : "Remove"}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmPrune(false)} disabled={pruneBusy}>
              Cancel
            </button>
          </div>
        )}
        {pruneSummary && (
          <div className="sp-prune" role="status">
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
                <div className="sp-mono sp-pre">{pruneSummary.keptDirty.join("\n")}</div>
              </div>
            )}
            {pruneSummary.failed > 0 && <div className="settings-error">{pruneSummary.errors.join("\n")}</div>}
          </div>
        )}
        {pruneError && (
          <div className="settings-error" role="alert">
            {pruneError}
          </div>
        )}
      </SettingsGroup>
      {dialog}
    </>
  );
}

function filledTextField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target.value !== "" ? target : null;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target.value !== "" ? target : null;
  return null;
}

export function SettingsPage({
  section,
  harness,
  onBack,
  onOpenUsage
}: {
  section: SettingsSection;
  harness?: DriverName;
  onBack: () => void;
  onOpenUsage: () => void;
}) {
  const draft = useSettingsDraftStore((s) => s.draft);
  const saved = useSettingsDraftStore((s) => s.saved);
  const dirty = useSettingsDraftStore((s) => s.dirty);
  const repoDirty = useSettingsDraftStore((s) => !sameValue(s.repoDraft, s.repoSaved));
  const loading = useSettingsDraftStore((s) => s.loading);
  const loadError = useSettingsDraftStore((s) => s.loadError);
  const saving = useSettingsDraftStore((s) => s.saving);
  const saveError = useSettingsDraftStore((s) => s.saveError);
  const load = useSettingsDraftStore((s) => s.load);
  const save = useSettingsDraftStore((s) => s.save);
  const discard = useSettingsDraftStore((s) => s.discard);
  const applied = useSettingsDraftStore((s) => s.applied);
  const set = useSettingsDraftStore((s) => s.set);
  const recheckHarnesses = useSettingsDraftStore((s) => s.recheckHarnesses);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const navId = navIdOf(section, harness);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (visibleLayerOpen()) return;
      e.preventDefault();
      const field = filledTextField(e.target);
      if (field) {
        field.blur();
        return;
      }
      onBackRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const pickBinary: BinaryPickHandler = async (patch) => {
    const stored = await useAppStore.getState().saveSettings(patch);
    const normalized: Partial<AppSettings> = {};
    for (const key of SETTING_KEYS) {
      if (key in patch) copySetting(normalized, stored, key);
    }
    applied(normalized);
    void recheckHarnesses();
  };

  const changedLabels = unsavedSectionLabels(saved, draft, repoDirty);

  const renderSection = (current: AppSettings): ReactNode => {
    switch (section) {
      case "general":
        return <GeneralSettings />;
      case "appearance":
        return (
          <>
            <SettingsPageHead title="Appearance" description="Typography and motion. Previews update as you edit; the app changes when you save." />
            <AppearanceSettings draft={current} onDraftChange={set} />
          </>
        );
      case "updates":
        return (
          <>
            <SettingsPageHead title="Updates" description="The channel and background downloads apply as soon as you change them." />
            <UpdatesSettings draft={current} fallbackVersion={appVersion} onApplied={applied} />
          </>
        );
      case "sourceControl":
        return <SourceControlSettings onPickBinary={pickBinary} />;
      case "prWorkflows":
        return <PrWorkflowSettings />;
      case "harness":
        return <HarnessSettings key={harness ?? "claude"} driver={harness ?? "claude"} onPickBinary={pickBinary} onOpenUsage={onOpenUsage} />;
    }
  };

  return (
    <div className="thread-col sp-page">
      <div className="head-seg main-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="head-col col-left">
          <nav className="sp-crumb" aria-label="Breadcrumb">
            <span>Settings</span>
            <ChevronRight size={12} aria-hidden="true" />
            {section === "harness" && (
              <>
                <span>Harnesses</span>
                <ChevronRight size={12} aria-hidden="true" />
              </>
            )}
            <strong aria-current="page">{navLabel(navId)}</strong>
          </nav>
        </div>
      </div>
      <div className="sp-scroll">
        <div className={`sp-in sp-in-${section}`}>
          {loading && <p className="sp-hint">Loading settings…</p>}
          {!loading && loadError && (
            <div className="sp-load-error" role="alert">
              <div className="settings-error">Could not load settings: {loadError}</div>
              <button type="button" className="btn" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {!loading && !loadError && draft && renderSection(draft)}
        </div>
      </div>
      {dirty && (
        <div className="sp-savebar" role="region" aria-label="Unsaved changes">
          <span className="sp-savebar-dot" aria-hidden="true" />
          <span className="sp-savebar-text">
            Unsaved changes in <b>{sectionSummary(changedLabels)}</b>
          </span>
          {saveError && (
            <span className="sp-savebar-error" role="alert" title={saveError}>
              {saveError}
            </span>
          )}
          <span className="sp-savebar-end">
            <button type="button" className="btn sp-btn-lg" onClick={discard} disabled={saving}>
              Discard
            </button>
            <button type="button" className="btn btn-primary sp-btn-lg" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
