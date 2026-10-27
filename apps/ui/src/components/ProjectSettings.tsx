import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, ChevronRight, FolderPlus, Gauge, GitBranch, Layers, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { DriverName, ModelOption, PermissionOption, Project, ProjectSettings, SourceControlHealth } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { accountKey, projectDirty, useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { useConfirm } from "./ConfirmDialog.js";
import { DriverIcon } from "./DriverIcon.js";
import { errorMessage } from "./errorMessage.js";
import { MenuSelect } from "./MenuSelect.js";
import { ProjectMonogram } from "./ProjectMonogram.js";
import {
  contextWindowLabel,
  effortLabel,
  effortOptionsFor,
  EFFORTS,
  FALLBACK_PERMISSIONS,
  hasContextSuffix,
  stripContextSuffix,
  withContextSuffix
} from "./modelMenus.js";
import { useNotifs } from "./Notifications.js";
import { shortenHome } from "./pathDisplay.js";
import { HARNESS_IDS, HARNESS_NAMES, sameValue } from "./settingsSections.js";
import { HelpTip, SettingsGroup, SettingsPageHead, SettingsRow } from "./SettingsLayout.js";
import { chooseProjectFolder } from "../platform/chooseProjectFolder.js";

const MAX_SCRIPT_CHARS = 20_000;
const MAX_INSTRUCTION_CHARS = 4_000;
const UNSET = "";

export function healthFailure(message: string): SourceControlHealth {
  return {
    git: { path: "git", available: false, version: null, error: message },
    githubCli: { path: "gh", available: false, version: null, error: message },
    repository: { available: false, root: null, branch: null, remoteUrl: null, githubHost: null, githubRepository: null, userName: null, userEmail: null, error: message },
    github: { accounts: [], selectedAccount: null, selectionSource: "none", error: message },
    issues: [{ level: "error", message }]
  };
}

function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((project) => project.name.toLowerCase().includes(q)) : projects;
}

function ProjectList() {
  const projects = useAppStore((s) => s.projects);
  const addProject = useAppStore((s) => s.addProject);
  const openProjectSettings = usePrStore((s) => s.openProjectSettings);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const { confirm, dialog } = useConfirm();

  const configure = async (project: Project) => {
    const store = useSettingsDraftStore.getState();
    const editing = store.projectDraft?.projectId ?? store.repoDraft?.projectId;
    if (editing && editing !== project.id && projectDirty(store)) {
      const name = projects.find((p) => p.id === editing)?.name ?? "the other project";
      const ok = await confirm({
        title: "Discard project changes?",
        message: `Your unsaved changes to ${name} will be lost.`,
        danger: true,
        confirmLabel: "Discard"
      });
      if (!ok) return;
      store.setProjectBaseline(null);
      store.setRepoBaseline(null);
    }
    openProjectSettings(project.id);
  };

  const addFolder = () => {
    setAdding(true);
    chooseProjectFolder()
      .then((dir) => (dir ? addProject(dir) : undefined))
      .catch((err: unknown) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: errorMessage(err) });
      })
      .finally(() => setAdding(false));
  };

  const shown = filterProjects(projects, query);

  return (
    <>
      <SettingsPageHead
        title="Projects"
        help="Folders you start sessions in. Open one to set its session defaults, worktree scripts, generated names and repository identity."
      />
      <SettingsGroup
        title="Projects"
        action={
          <>
            {projects.length > 0 && (
              <label className="side-search sp-project-search">
                <Search size={14} aria-hidden="true" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" />
                {query && (
                  <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </label>
            )}
            <button type="button" className="btn sp-btn-sm" onClick={addFolder} disabled={adding}>
              <FolderPlus size={12} aria-hidden="true" /> {adding ? "Adding…" : "Add project…"}
            </button>
          </>
        }
      >
        {projects.length === 0 ? (
          <p className="sp-hint">No projects yet. Add a folder to start sessions in it.</p>
        ) : shown.length === 0 ? (
          <p className="sp-hint">No projects match “{query.trim()}”.</p>
        ) : (
          <ul className="sp-list" aria-label="Projects">
            {shown.map((project) => (
              <li key={project.id}>
                <button type="button" className="sp-project-row" onClick={() => void configure(project)} title={project.rootPath}>
                  <ProjectMonogram name={project.name} size={16} />
                  <span>{project.name}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
      {dialog}
    </>
  );
}

function useHarnessOptions<T>(load: () => Promise<T[]>, key: string): { items: T[] | null; error: string | null } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    loadRef
      .current()
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err) || "Could not load options");
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return { items, error };
}

function SessionDefaults({ project, settings, onChange }: { project: Project; settings: ProjectSettings; onChange: (patch: Partial<ProjectSettings>) => void }) {
  const checks = useSettingsDraftStore((s) => s.harnessChecks);
  const lastDriver = useAppStore((s) => s.lastDriver);
  const driver = settings.defaultDriver;
  const permissionDriver: DriverName = driver ?? lastDriver;
  const models = useHarnessOptions<ModelOption>(() => (driver ? window.cw.listModelsFor(project.id, driver) : Promise.resolve([])), `${project.id}:${driver ?? ""}`);
  const permissions = useHarnessOptions<PermissionOption>(() => window.cw.listPermissionsFor(project.id, permissionDriver), `${project.id}:${permissionDriver}`);
  const model = settings.defaultModel ?? "";
  const baseModel = driver === "claude" ? stripContextSuffix(model) : model;
  const oneM = driver === "claude" && hasContextSuffix(model);
  const modelList = models.items ?? [];
  const savedModelMissing = baseModel !== "" && models.items !== null && !modelList.some((m) => m.id === baseModel);
  const effortOptions = driver ? effortOptionsFor(driver, modelList, baseModel || undefined) : EFFORTS;
  const permissionList = permissions.items && permissions.items.length > 0 ? permissions.items : FALLBACK_PERMISSIONS;
  const status = models.error ?? permissions.error;

  const pickDriver = (id: string) => {
    const next = HARNESS_IDS.find((h) => h === id);
    if (next === driver) return;
    onChange({ defaultDriver: next, defaultModel: undefined });
  };

  return (
    <SettingsGroup
      title="General"
      help={`Preselected when you start a new session in ${project.name}; you can still change them in the composer. “Last used” keeps what the composer had before. Models and permission modes come from the selected harness.`}
    >
      <div className="sp-card">
        <div className="sp-card-grid">
          <div className="sp-field">
            <span>Harness</span>
            <MenuSelect
              label="Default harness"
              title="Harness preselected for new sessions"
              direction="down"
              value={driver ?? UNSET}
              display={driver ? HARNESS_NAMES[driver] : "Last used"}
              icon={driver ? <DriverIcon driver={driver} size={13} /> : <Layers size={13} aria-hidden="true" />}
              options={[
                { id: UNSET, label: "Last used", hint: "Last used", description: "Keep the harness of your last session" },
                ...HARNESS_IDS.map((id) => {
                  const unavailable = checks?.find((check) => check.binary === id)?.available === false;
                  return {
                    id,
                    label: HARNESS_NAMES[id],
                    hint: HARNESS_NAMES[id],
                    description: unavailable ? "Not installed" : undefined,
                    disabled: unavailable && id !== driver,
                    icon: <DriverIcon driver={id} size={13} />
                  };
                })
              ]}
              onPick={pickDriver}
            />
          </div>
          <div className="sp-field">
            <span>Model</span>
            {driver ? (
              <MenuSelect
                label="Default model"
                title="Model preselected for new sessions"
                direction="down"
                value={baseModel}
                display={baseModel === "" ? "Harness default" : (modelList.find((m) => m.id === baseModel)?.label ?? baseModel)}
                icon={<Bot size={13} aria-hidden="true" />}
                options={[
                  { id: UNSET, label: "Harness default", hint: "Harness default", description: "Use the model starred in the composer" },
                  ...modelList.map((m) => ({ id: m.id, label: m.label, hint: m.id })),
                  ...(savedModelMissing ? [{ id: baseModel, label: `${baseModel} (saved)`, hint: baseModel }] : [])
                ]}
                onPick={(id) => onChange({ defaultModel: id === UNSET ? undefined : driver === "claude" ? withContextSuffix(id, oneM) : id })}
                searchable
                searchPlaceholder="Filter models…"
              />
            ) : (
              <span className="sp-hint">Pick a harness to choose its model.</span>
            )}
          </div>
          {driver === "claude" && (
            <div className="sp-field">
              <span>Context window</span>
              <MenuSelect
                label="Default context window"
                title={baseModel ? "Context window for the default model" : "Pick a model first"}
                direction="down"
                value={oneM ? "1m" : "200k"}
                display={contextWindowLabel(oneM)}
                icon={<Layers size={13} aria-hidden="true" />}
                options={[
                  { id: "200k", label: contextWindowLabel(false), hint: "Standard context" },
                  { id: "1m", label: contextWindowLabel(true), hint: "1M context", disabled: baseModel === "" }
                ]}
                onPick={(id) => {
                  if (baseModel) onChange({ defaultModel: withContextSuffix(baseModel, id === "1m") });
                }}
              />
            </div>
          )}
          <div className="sp-field">
            <span>Effort</span>
            <MenuSelect
              label="Default effort"
              title="Reasoning effort preselected for new sessions"
              direction="down"
              value={settings.defaultEffort ?? UNSET}
              display={settings.defaultEffort ? effortLabel(settings.defaultEffort) : "Last used"}
              icon={<Gauge size={13} aria-hidden="true" />}
              options={[
                { id: UNSET, label: "Last used", hint: "Last used" },
                ...effortOptions.map((effort) => ({ id: effort.id, label: effort.label, hint: effort.label }))
              ]}
              onPick={(id) => onChange({ defaultEffort: effortOptions.find((effort) => effort.id === id)?.id })}
            />
          </div>
          <div className="sp-field">
            <span>Permission mode</span>
            <MenuSelect
              label="Default permission mode"
              title="Permission mode preselected for new sessions"
              direction="down"
              value={settings.defaultPermissionMode ?? UNSET}
              display={settings.defaultPermissionMode ? (permissionList.find((p) => p.id === settings.defaultPermissionMode)?.label ?? settings.defaultPermissionMode) : "Last used"}
              icon={<ShieldCheck size={13} aria-hidden="true" />}
              options={[
                { id: UNSET, label: "Last used", hint: "Last used" },
                ...permissionList.map((p) => ({ id: p.id, label: p.label, hint: p.label, description: p.description }))
              ]}
              onPick={(id) => onChange({ defaultPermissionMode: permissionList.find((p) => p.id === id)?.id })}
            />
          </div>
        </div>
        {(status || (driver && models.items === null)) && (
          <div className={`sp-card-foot${status ? " bad" : ""}`} role={status ? "alert" : undefined}>
            {status ?? "Loading models…"}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}

function TextSetting({
  id,
  label,
  hint,
  value,
  placeholder,
  maxLength,
  code,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string | undefined;
  placeholder: string;
  maxLength: number;
  code?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="sp-stack">
      <span className="sp-lab sp-lab-help">
        <label htmlFor={id}>{label}</label>
        <HelpTip label={label}>{hint}</HelpTip>
      </span>
      <textarea
        id={id}
        className={`sp-code sp-template sp-code-sm${code ? "" : " sp-prose"}`}
        value={value ?? ""}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={!code}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function RepositorySettings({ project }: { project: Project }) {
  const repoDraft = useSettingsDraftStore((s) => s.repoDraft);
  const setRepo = useSettingsDraftStore((s) => s.setRepo);
  const [health, setHealth] = useState<SourceControlHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const projectId = project.id;

  const loadHealth = useCallback(() => {
    const id = ++request.current;
    const current = () => id === request.current;
    setLoading(true);
    window.cw
      .getSourceControlHealth(projectId)
      .then((next) => {
        if (!current()) return;
        setHealth(next);
        const store = useSettingsDraftStore.getState();
        if (store.repoSaved?.projectId === projectId && !sameValue(store.repoDraft, store.repoSaved)) return;
        const latest = useAppStore.getState().projects.find((p) => p.id === projectId);
        store.setRepoBaseline({
          projectId,
          account: accountKey(latest?.githubAccount),
          userName: next.repository.userName ?? "",
          userEmail: next.repository.userEmail ?? "",
          identityEditable: next.repository.available
        });
      })
      .catch((err: unknown) => {
        if (current()) setHealth(healthFailure(errorMessage(err)));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const ready = repoDraft !== null && repoDraft.projectId === projectId && health?.repository.available === true;

  return (
    <SettingsGroup
      title="Repository"
      action={
        <button type="button" className="btn sp-btn-sm" onClick={loadHealth} disabled={loading}>
          <RefreshCw size={12} aria-hidden="true" /> {loading ? "Checking…" : "Recheck"}
        </button>
      }
    >
      {!health && loading && <p className="sp-hint">Inspecting repository…</p>}
      {health?.issues.map((issue, index) => (
        <div key={`${issue.level}:${index}`} className={`sp-issue ${issue.level}`} role={issue.level === "error" ? "alert" : undefined}>
          <AlertTriangle size={13} aria-hidden="true" /> {issue.message}
        </div>
      ))}
      {health?.repository.available && ready && (
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
            htmlFor="sp-project-account"
            help={`Automatic currently resolves ${health.github.selectedAccount ? `@${health.github.selectedAccount}` : "no account"}${health.github.selectionSource !== "none" ? ` by ${health.github.selectionSource}` : ""}.`}
          >
            <select id="sp-project-account" className="field sp-select" value={repoDraft.account} onChange={(e) => setRepo({ account: e.target.value })}>
              <option value="">Automatic (recommended)</option>
              {project.githubAccount &&
                !health.github.accounts.some((account) => account.host === project.githubAccount?.host && account.login === project.githubAccount?.login) && (
                  <option value={accountKey(project.githubAccount)} disabled>
                    {project.githubAccount.login} · {project.githubAccount.host} · unavailable
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
          <SettingsRow label="Commit author name" help="Stored in this repository's local Git config." htmlFor="sp-project-name">
            <input id="sp-project-name" className="field" value={repoDraft.userName} placeholder="Your name" onChange={(e) => setRepo({ userName: e.target.value })} />
          </SettingsRow>
          <SettingsRow label="Commit author email" help="Use the email tied to this project's GitHub account." htmlFor="sp-project-email">
            <input
              id="sp-project-email"
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
  );
}

function ProjectDetail({ project }: { project: Project }) {
  const homeDir = useAppStore((s) => s.homeDir);
  const projectDraft = useSettingsDraftStore((s) => s.projectDraft);
  const setProjectSettings = useSettingsDraftStore((s) => s.setProjectSettings);
  const projectId = project.id;

  useEffect(() => {
    const store = useSettingsDraftStore.getState();
    if (store.projectSaved?.projectId === projectId && !sameValue(store.projectDraft, store.projectSaved)) return;
    store.setProjectBaseline({ projectId, settings: project.settings ?? {} });
  }, [projectId, project.settings]);

  if (projectDraft?.projectId !== projectId) return null;
  const settings = projectDraft.settings;

  return (
    <>
      <SettingsPageHead title={project.name} description={<span className="sp-mono">{shortenHome(project.rootPath, homeDir ?? undefined)}</span>} />
      <SessionDefaults project={project} settings={settings} onChange={setProjectSettings} />

      <SettingsGroup
        title="Worktree lifecycle scripts"
        help="Run with PowerShell on Windows and your shell elsewhere, inside the session worktree. They receive CW_WORKTREE_PATH, CW_PROJECT_ROOT, CW_SESSION_ID and CW_BRANCH. Failures are reported but never block the session."
      >
        <TextSetting
          id="sp-project-setup"
          label="Setup"
          hint="Runs after cw-code creates a worktree for a new session. The first turn waits for it to finish."
          value={settings.setupScript}
          placeholder="bun install"
          maxLength={MAX_SCRIPT_CHARS}
          code
          onChange={(value) => setProjectSettings({ setupScript: value })}
        />
        <TextSetting
          id="sp-project-destroy"
          label="Destroy"
          hint="Runs before cw-code removes a session worktree. Skipped when the worktree has uncommitted changes, since it is kept."
          value={settings.destroyScript}
          placeholder="docker compose down"
          maxLength={MAX_SCRIPT_CHARS}
          code
          onChange={(value) => setProjectSettings({ destroyScript: value })}
        />
      </SettingsGroup>

      <SettingsGroup title="Metadata generation" help="Sent with the title request, which uses the harness and model from General settings.">
        <TextSetting
          id="sp-project-title-instructions"
          label="Title instructions"
          hint="Extra guidance for generated session titles."
          value={settings.titleInstructions}
          placeholder="Start with the Jira key when the message mentions one, e.g. ABC-123 Fix login redirect"
          maxLength={MAX_INSTRUCTION_CHARS}
          onChange={(value) => setProjectSettings({ titleInstructions: value })}
        />
        <TextSetting
          id="sp-project-branch-instructions"
          label="Branch naming instructions"
          hint="How to name the branch of a new worktree session. When empty, the branch follows the title as cw/<title>."
          value={settings.branchInstructions}
          placeholder="Use feat/, fix/ or chore/ followed by a short kebab-case summary"
          maxLength={MAX_INSTRUCTION_CHARS}
          onChange={(value) => setProjectSettings({ branchInstructions: value })}
        />
      </SettingsGroup>

      <RepositorySettings project={project} />
    </>
  );
}

export function ProjectsSettings({ projectId }: { projectId?: string }) {
  const project = useAppStore((s) => (projectId ? s.projects.find((p) => p.id === projectId) : undefined));

  if (project) return <ProjectDetail key={project.id} project={project} />;
  return <ProjectList />;
}
