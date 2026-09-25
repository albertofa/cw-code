import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  Copy,
  Eye,
  Gauge,
  GitBranch,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  Wrench,
  X,
  XCircle
} from "lucide-react";
import type { AppSettings, DriverName, EffortLevel, ModelOption, SourceControlHealth, WorktreePruneSummary } from "../cw.js";
import { BinaryPicker } from "./BinaryPicker.js";
import { TOOL_TABS } from "./toolTabs.js";
import type { PanelId, PrSuggestCondition, PrWorkflow, PrWorkflowIcon, PrWorkspaceChoice } from "@cw-code/contracts";
import { useAppStore } from "../stores/appStore.js";
import { concreteFilterId } from "./projectRecency.js";
import { usePanelStore } from "../stores/panelStore.js";
import { useNotifs } from "./Notifications.js";
import { MenuSelect } from "./MenuSelect.js";
import { UpdatesSettings } from "./UpdatesSettings.js";
import { DriverIcon } from "./DriverIcon.js";
import appIcon from "../assets/console-c.svg";
import { version as appVersion, description as appDescription } from "../../../../package.json";
import { attributionText, TEMPLATE_VARS } from "./prWorkflows.js";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, insertAtCursor, moveWorkflow, resetWorkflowTo } from "./prWorkflowEditor.js";

const WORKFLOW_ICONS: Record<PrWorkflowIcon, typeof Eye> = {
  eye: Eye,
  activity: Activity,
  message: MessageSquare,
  wrench: Wrench,
  merge: GitMerge,
  bot: Bot,
  sparkle: Sparkles
};

const CONDITION_LABELS: Record<PrSuggestCondition, string> = {
  "review-requested": "Review requested from me",
  author: "I'm the author",
  "checks-failing": "Checks failing",
  "changes-requested": "Changes requested",
  conflicts: "Has conflicts",
  "bot-author": "Author is a bot",
  draft: "Draft"
};

const ALL_CONDITIONS: PrSuggestCondition[] = [
  "review-requested",
  "author",
  "checks-failing",
  "changes-requested",
  "conflicts",
  "bot-author",
  "draft"
];

const WORKSPACE_OPTIONS: Array<{ id: PrWorkspaceChoice; label: string; hint: string }> = [
  { id: "checkout", label: "Current checkout", hint: "Use the project folder as-is." },
  { id: "worktree", label: "Worktree at PR head", hint: "Check the PR head out into a new worktree." },
  { id: "linked", label: "Linked session's workspace", hint: "Reuse the linked session's workspace; falls back to a worktree." }
];

// Must match CLAUDE_CURATED_MODELS in apps/desktop/src/main/providers/claude/ClaudeCliDriver.ts.
// Main drops unknown ids on save, so keep this list in sync with the driver.
const CURATED_MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
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
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" }
];

type Category = "general" | "updates" | "sourceControl" | "prWorkflows" | "harnesses";
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
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const startPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const updatePromptRef = useRef<HTMLTextAreaElement | null>(null);
  const projects = useAppStore((state) => state.projects);
  const [configProjectId, setConfigProjectId] = useState<string | null>(() => {
    const state = useAppStore.getState();
    return state.activeProjectId ?? concreteFilterId(state.projects, state.projectFilter) ?? state.projects[0]?.id ?? null;
  });
  const configProject = projects.find((project) => project.id === configProjectId) ?? projects[0];
  const configId = configProject?.id ?? null;
  const tabAutoLocation = usePanelStore((s) => s.autoLocation);
  const setTabAutoLocation = usePanelStore((s) => s.setAutoLocation);

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
    setProjectAccount(configProject?.githubAccount ? `${configProject.githubAccount.host}\t${configProject.githubAccount.login}` : "");
  }, [configProject?.id, configProject?.githubAccount?.host, configProject?.githubAccount?.login]);

  const healthRequest = useRef(0);
  const loadSourceControlHealth = useCallback(() => {
    const request = ++healthRequest.current;
    const current = () => request === healthRequest.current;
    setHealthLoading(true);
    void window.cw.getSourceControlHealth(configId ?? undefined)
      .then((next) => {
        if (!current()) return;
        setHealth(next);
        setGitUserName(next.repository.userName ?? "");
        setGitUserEmail(next.repository.userEmail ?? "");
      })
      .catch((error: Error) => {
        if (!current()) return;
        setHealth({
          git: { path: "git", available: false, version: null, error: error.message },
          githubCli: { path: "gh", available: false, version: null, error: error.message },
          repository: { available: false, root: null, branch: null, remoteUrl: null, githubHost: null, githubRepository: null, userName: null, userEmail: null, error: error.message },
          github: { accounts: [], selectedAccount: null, selectionSource: "none", error: error.message },
          issues: [{ level: "error", message: error.message }]
        });
      })
      .finally(() => {
        if (current()) setHealthLoading(false);
      });
  }, [configId]);

  useEffect(() => {
    if (category === "sourceControl") loadSourceControlHealth();
  }, [category, loadSourceControlHealth]);

  useEffect(() => {
    if (category !== "prWorkflows" || !draft) return;
    if (!draft.prWorkflows.some((w) => w.id === selectedWorkflowId)) {
      setSelectedWorkflowId(draft.prWorkflows[0]?.id ?? null);
    }
  }, [category, draft, selectedWorkflowId]);

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

  type BinarySettingKey =
    | "claudeBinaryPath"
    | "opencodeBinaryPath"
    | "codexBinaryPath"
    | "gitBinaryPath"
    | "githubCliBinaryPath";

  const makeOnPick = (key: BinarySettingKey) => async (path: string) => {
    await useAppStore.getState().saveSettings({ [key]: path } as Partial<AppSettings>);
    setDraft((d) => (d ? ({ ...d, [key]: path } as AppSettings) : d));
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
      if (configId) {
        const [host, login] = projectAccount.split("\t");
        await store.setProjectGitHubAccount(configId, host && login ? { host, login } : null);
        if (health?.repository.available && (gitUserName.trim() !== (health.repository.userName ?? "") || gitUserEmail.trim() !== (health.repository.userEmail ?? ""))) {
          await window.cw.setRepositoryGitIdentity(configId, gitUserName, gitUserEmail);
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
      const message = err instanceof Error ? err.message : "Could not prune worktrees";
      setPruneError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not prune worktrees", message });
    } finally {
      setPruneBusy(false);
    }
  };

  const setWorkflows = (next: PrWorkflow[]) => set({ prWorkflows: next });

  const toggleWorkflowEnabled = (id: string) => {
    if (!draft) return;
    setWorkflows(draft.prWorkflows.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)));
  };

  const moveWorkflowEntry = (id: string, direction: "up" | "down") => {
    if (!draft) return;
    setWorkflows(moveWorkflow(draft.prWorkflows, id, direction));
  };

  const addWorkflow = () => {
    if (!draft) return;
    const next = createWorkflow(draft.prWorkflows);
    setWorkflows(next);
    setSelectedWorkflowId(next[next.length - 1].id);
  };

  const duplicateSelectedWorkflow = () => {
    if (!draft || !selectedWorkflowId) return;
    const sourceIndex = draft.prWorkflows.findIndex((w) => w.id === selectedWorkflowId);
    const next = duplicateWorkflow(draft.prWorkflows, selectedWorkflowId);
    setWorkflows(next);
    const added = sourceIndex !== -1 ? next[sourceIndex + 1] : undefined;
    if (added) setSelectedWorkflowId(added.id);
  };

  const deleteSelectedWorkflow = (id: string) => {
    if (!draft) return;
    const next = deleteWorkflow(draft.prWorkflows, id);
    setWorkflows(next);
    if (selectedWorkflowId === id) setSelectedWorkflowId(next[0]?.id ?? null);
  };

  const updateSelectedWorkflow = (patch: Partial<PrWorkflow>) => {
    if (!draft || !selectedWorkflowId) return;
    setWorkflows(draft.prWorkflows.map((w) => (w.id === selectedWorkflowId ? { ...w, ...patch } : w)));
  };

  const toggleCondition = (workflow: PrWorkflow, condition: PrSuggestCondition) => {
    const has = workflow.suggestWhen.includes(condition);
    updateSelectedWorkflow({
      suggestWhen: has ? workflow.suggestWhen.filter((c) => c !== condition) : [...workflow.suggestWhen, condition]
    });
  };

  const insertTemplateVar = (field: "startPrompt" | "updatePrompt", workflow: PrWorkflow, token: string) => {
    const ref = field === "startPrompt" ? startPromptRef : updatePromptRef;
    const el = ref.current;
    const current = workflow[field];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const { value, cursor } = insertAtCursor(current, `{{${token}}}`, start, end);
    updateSelectedWorkflow(field === "startPrompt" ? { startPrompt: value } : { updatePrompt: value });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  };

  const resetSelectedWorkflow = async (id: string) => {
    if (!draft) return;
    setResetBusyId(id);
    setResetError(null);
    try {
      const defaults = await window.cw.getDefaultPrWorkflows();
      setDraft((d) => (d ? { ...d, prWorkflows: resetWorkflowTo(d.prWorkflows, id, defaults) } : d));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not reset workflow";
      setResetError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not reset workflow", message });
    } finally {
      setResetBusyId(null);
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
      <div className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Verified installs only. Picking one applies immediately.</span>
        <BinaryPicker
          key="claude"
          binary="claude"
          value={draft.claudeBinaryPath}
          onPick={makeOnPick("claudeBinaryPath")}
          autoDiscoverKey={`harness:claude:${draft.claudeBinaryPath}`}
        />
      </div>
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
      <label className="settings-row">
        <span className="settings-label">Chain of thought expanded</span>
        <span className="settings-hint">Show Claude reasoning expanded by default instead of collapsed behind a “Thought for Xs” summary.</span>
        <input
          className="settings-toggle"
          type="checkbox"
          checked={draft.claudeReasoningExpanded}
          onChange={(e) => set({ claudeReasoningExpanded: e.target.checked })}
          aria-label="Expand Claude reasoning by default"
        />
      </label>
      {modelsSection}
    </>
  );

  const opencodeFields = draft && (
    <>
      <div className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Verified installs only. Picking one applies immediately.</span>
        <BinaryPicker
          key="opencode"
          binary="opencode"
          value={draft.opencodeBinaryPath}
          onPick={makeOnPick("opencodeBinaryPath")}
          autoDiscoverKey={`harness:opencode:${draft.opencodeBinaryPath}`}
        />
      </div>
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
      <label className="settings-row">
        <span className="settings-label">Chain of thought expanded</span>
        <span className="settings-hint">Show OpenCode reasoning expanded by default instead of collapsed behind a “Thought for Xs” summary.</span>
        <input
          className="settings-toggle"
          type="checkbox"
          checked={draft.opencodeReasoningExpanded}
          onChange={(e) => set({ opencodeReasoningExpanded: e.target.checked })}
          aria-label="Expand OpenCode reasoning by default"
        />
      </label>
      <label className="settings-row">
        <span className="settings-label">Show OpenCode Go plan limits</span>
        <span className="settings-hint">
          Reads your OpenCode Go key from opencode&apos;s auth file. The key stays on this device and is only sent to opencode.ai.
        </span>
        <input
          className="settings-toggle"
          type="checkbox"
          checked={draft.opencodeGoUsage}
          onChange={(e) => set({ opencodeGoUsage: e.target.checked })}
          aria-label="Show OpenCode Go plan limits"
        />
      </label>
    </>
  );

  const codexFields = draft && (
    <>
      <div className="settings-row">
        <span className="settings-label">Binary path</span>
        <span className="settings-hint">Verified installs only. Picking one applies immediately.</span>
        <BinaryPicker
          key="codex"
          binary="codex"
          value={draft.codexBinaryPath}
          onPick={makeOnPick("codexBinaryPath")}
          autoDiscoverKey={`harness:codex:${draft.codexBinaryPath}`}
        />
      </div>
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
      <label className="settings-row">
        <span className="settings-label">Chain of thought expanded</span>
        <span className="settings-hint">Show Codex reasoning expanded by default instead of collapsed behind a “Thought for Xs” summary.</span>
        <input
          className="settings-toggle"
          type="checkbox"
          checked={draft.codexReasoningExpanded}
          onChange={(e) => set({ codexReasoningExpanded: e.target.checked })}
          aria-label="Expand Codex reasoning by default"
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

  const tabFields = (
    <section className="settings-section">
      <h3>Workspace tabs</h3>
      <span className="settings-hint">Clicking a right-rail icon opens that tab in its auto location, which applies immediately. Drag tabs between panels any time; the rail icons always stay.</span>
      {TOOL_TABS.map((tab) => (
        <label className="settings-row" key={tab.id}>
          <span className="settings-label">
            <tab.Icon size={13} aria-hidden="true" /> {tab.title}
          </span>
          <span className="settings-hint">Where this tab opens from the right rail.</span>
          <select
            className="field"
            value={tabAutoLocation[tab.id]}
            onChange={(e) => setTabAutoLocation(tab.id, e.target.value as PanelId)}
            aria-label={`${tab.title} auto location`}
          >
            <option value="main">Main panel</option>
            <option value="right">Right panel</option>
            <option value="bottom">Bottom panel</option>
          </select>
        </label>
      ))}
    </section>
  );

  const holdingFields = draft && (
    <section className="settings-section">
      <h3>Sessions</h3>
      <label className="settings-row">
        <span className="settings-label">Working set hold</span>
        <span className="settings-hint">Sessions stay in the Working set for this long after their last activity before returning to their project. 0 disables.</span>
        <span className="settings-number-field">
          <input className="field" type="number" min={0} max={168} value={draft.holdingHours} onChange={(e) => set({ holdingHours: Number(e.target.value) })} />
          <span>hours</span>
        </span>
      </label>
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
        <div className="settings-row">
          <span className="settings-label">Git executable</span>
          <span className="settings-hint">Used for status, branches, diffs, identity, and worktrees. Picking one applies immediately.</span>
          <BinaryPicker
            key="git"
            binary="git"
            value={draft.gitBinaryPath}
            onPick={makeOnPick("gitBinaryPath")}
            autoDiscoverKey={`sourceControl:git:${draft.gitBinaryPath}`}
          />
        </div>
        <div className="settings-row">
          <span className="settings-label">GitHub CLI executable</span>
          <span className="settings-hint">Used for account discovery and pull-request status. Picking one applies immediately.</span>
          <BinaryPicker
            key="gh"
            binary="gh"
            value={draft.githubCliBinaryPath}
            onPick={makeOnPick("githubCliBinaryPath")}
            autoDiscoverKey={`sourceControl:gh:${draft.githubCliBinaryPath}`}
          />
        </div>
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

      {configProject && (
        <section className="settings-section">
          <h3>Project</h3>
          <label className="settings-row">
            <span className="settings-label">Configure</span>
            <span className="settings-hint">Repository and GitHub account settings below apply to this project.</span>
            <select
              className="field"
              value={configProject.id}
              onChange={(e) => {
                setHealth(null);
                setConfigProjectId(e.target.value);
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          {!health && healthLoading && <div className="side-empty">Inspecting repository…</div>}
          {health && !health.repository.available && (
            <div className="side-empty">{health.repository.error ?? "This project is not a Git repository."}</div>
          )}
        </section>
      )}
      {configProject && health?.repository.available && (
        <section className="settings-section">
          <h3>{configProject.name}</h3>
          <div className="settings-repo-summary">
            <GitBranch size={14} />
            <span><b>{health.repository.githubRepository ?? health.repository.root}</b><small>{health.repository.remoteUrl ?? "No remote"}</small></span>
          </div>
          <label className="settings-row">
            <span className="settings-label">GitHub account</span>
            <span className="settings-hint">Auto discovery currently resolves {health.github.selectedAccount ? `@${health.github.selectedAccount}` : "no account"}{health.github.selectionSource !== "none" ? ` by ${health.github.selectionSource}` : ""}.</span>
            <select className="field" value={projectAccount} onChange={(e) => setProjectAccount(e.target.value)}>
              <option value="">Automatic (recommended)</option>
              {configProject.githubAccount && !health.github.accounts.some((account) => account.host === configProject.githubAccount?.host && account.login === configProject.githubAccount?.login) && (
                <option value={`${configProject.githubAccount.host}\t${configProject.githubAccount.login}`} disabled>{configProject.githubAccount.login} · {configProject.githubAccount.host} · unavailable</option>
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
      {!configProject && <div className="side-empty">Add a project to configure its repository and GitHub account.</div>}
    </>
  );

  const prWorkflowsFields = draft && (() => {
    const workflows = draft.prWorkflows;
    const selected = workflows.find((w) => w.id === selectedWorkflowId) ?? null;
    const SelectedIcon = selected ? WORKFLOW_ICONS[selected.icon] : null;
    return (
      <div className="settings-prwf">
        <div className="settings-prwf-list">
          <div className="settings-prwf-list-head">
            <h3>Workflows</h3>
            <button className="btn" onClick={addWorkflow}>
              <Plus size={13} aria-hidden="true" /> New
            </button>
          </div>
          <div className="settings-prwf-list-body">
            {workflows.map((w, index) => {
              const Icon = WORKFLOW_ICONS[w.icon];
              return (
                <div
                  key={w.id}
                  className={`settings-prwf-item${selected?.id === w.id ? " active" : ""}`}
                  onClick={() => setSelectedWorkflowId(w.id)}
                >
                  <span className="settings-prwf-item-reorder">
                    <button
                      className="icon-btn"
                      aria-label={`Move ${w.label} up`}
                      disabled={index === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveWorkflowEntry(w.id, "up");
                      }}
                    >
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${w.label} down`}
                      disabled={index === workflows.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveWorkflowEntry(w.id, "down");
                      }}
                    >
                      <ArrowDown size={12} aria-hidden="true" />
                    </button>
                  </span>
                  <Icon size={15} aria-hidden="true" />
                  <span className="settings-prwf-item-text">
                    <span className="settings-prwf-item-name">
                      {w.label}
                      {!w.builtIn && <span className="settings-tag">custom</span>}
                    </span>
                    <span className="settings-prwf-item-hint">
                      {w.suggestWhen.length > 0 ? w.suggestWhen.map((c) => CONDITION_LABELS[c]).join(", ") : "Manual only"}
                    </span>
                  </span>
                  <span className="settings-switch" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={() => toggleWorkflowEnabled(w.id)}
                      aria-label={`Enable ${w.label}`}
                    />
                    <span className="track" aria-hidden="true" />
                  </span>
                </div>
              );
            })}
          </div>
          <div className="settings-prwf-global">
            <h4>Repositories</h4>
            <label className="settings-row">
              <span className="settings-label">Clone root</span>
              <span className="settings-hint">Where repos that aren&apos;t cw-code projects yet get cloned to, as <span className="settings-id">&lt;root&gt;/&lt;owner&gt;/&lt;repo&gt;</span>.</span>
              <input
                className="field"
                value={draft.prCloneRoot}
                placeholder="~/.cw-code/repos"
                onChange={(e) => set({ prCloneRoot: e.target.value })}
              />
            </label>
            <h4>Updates</h4>
            <label className="settings-row">
              <span className="settings-label">Refresh interval</span>
              <span className="settings-hint">How often linked PRs and the inbox refresh. 30–3600 seconds.</span>
              <span className="settings-number-field">
                <input
                  className="field"
                  type="number"
                  min={30}
                  max={3600}
                  value={draft.prRefreshIntervalSeconds}
                  onChange={(e) => set({ prRefreshIntervalSeconds: Number(e.target.value) })}
                  onBlur={() => set({ prRefreshIntervalSeconds: Math.min(3600, Math.max(30, draft.prRefreshIntervalSeconds || 30)) })}
                />
                <span>seconds</span>
              </span>
            </label>
            <h4>Attribution</h4>
            <label className="settings-row">
              <span className="settings-label">Sign what the agent posts</span>
              <span className="settings-hint">Resolves the <span className="settings-id">{"{{attribution}}"}</span> template variable. Off resolves to nothing.</span>
              <span className="settings-switch">
                <input
                  type="checkbox"
                  checked={draft.prAttributionEnabled}
                  onChange={(e) => set({ prAttributionEnabled: e.target.checked })}
                  aria-label="Sign what the agent posts"
                />
                <span className="track" aria-hidden="true" />
              </span>
            </label>
            <label className="settings-row">
              <span className="settings-label">Attribution text</span>
              <span className="settings-hint">Use <span className="settings-id">{"{{harness}}"}</span> for the CLI name.</span>
              <input
                className="field"
                value={draft.prAttributionText}
                disabled={!draft.prAttributionEnabled}
                onChange={(e) => set({ prAttributionText: e.target.value })}
              />
            </label>
            <div className="settings-prwf-preview">
              <span className="settings-hint">Preview</span>
              <span className="settings-prwf-preview-text">
                {attributionText(draft, "Claude") || "— nothing (attribution is off)"}
              </span>
            </div>
          </div>
        </div>
        {selected && SelectedIcon ? (
          <div className="settings-prwf-editor">
            <div className="settings-prwf-editor-head">
              <span className="settings-prwf-editor-icon">
                <SelectedIcon size={20} aria-hidden="true" />
              </span>
              <div className="settings-prwf-editor-title">
                <input
                  className="field settings-prwf-name"
                  value={selected.label}
                  aria-label="Workflow label"
                  onChange={(e) => updateSelectedWorkflow({ label: e.target.value })}
                />
                <input
                  className="field settings-prwf-desc"
                  value={selected.description}
                  placeholder="Description"
                  aria-label="Workflow description"
                  onChange={(e) => updateSelectedWorkflow({ description: e.target.value })}
                />
              </div>
              <MenuSelect
                label="Icon"
                title="Workflow icon"
                direction="down"
                value={selected.icon}
                display={selected.icon}
                icon={<SelectedIcon size={13} aria-hidden="true" />}
                options={(Object.keys(WORKFLOW_ICONS) as PrWorkflowIcon[]).map((id) => {
                  const OptionIcon = WORKFLOW_ICONS[id];
                  return { id, label: id, icon: <OptionIcon size={13} aria-hidden="true" /> };
                })}
                onPick={(id) => updateSelectedWorkflow({ icon: id as PrWorkflowIcon })}
              />
              <div className="settings-prwf-editor-actions">
                <button className="btn" onClick={duplicateSelectedWorkflow}>
                  <Copy size={13} aria-hidden="true" /> Duplicate
                </button>
                {selected.builtIn ? (
                  <button className="btn" disabled={resetBusyId === selected.id} onClick={() => void resetSelectedWorkflow(selected.id)}>
                    <RotateCcw size={13} aria-hidden="true" /> {resetBusyId === selected.id ? "Resetting…" : "Reset to default"}
                  </button>
                ) : (
                  <button className="btn btn-danger" onClick={() => deleteSelectedWorkflow(selected.id)}>
                    <Trash2 size={13} aria-hidden="true" /> Delete
                  </button>
                )}
              </div>
            </div>
            {resetError && <div className="settings-error">{resetError}</div>}

            <section className="settings-prwf-block">
              <h4>Suggest when<span className="settings-hint">Shows as the row&apos;s primary action in the inbox and tops the workflow menu.</span></h4>
              <div className="settings-prwf-conds">
                {ALL_CONDITIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`settings-prwf-cond${selected.suggestWhen.includes(c) ? " on" : ""}`}
                    onClick={() => toggleCondition(selected, c)}
                  >
                    {CONDITION_LABELS[c]}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-prwf-block">
              <h4>Default workspace</h4>
              <div className="seg settings-prwf-workspace">
                {WORKSPACE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={selected.workspace === opt.id ? "on" : ""}
                    title={opt.hint}
                    onClick={() => updateSelectedWorkflow({ workspace: opt.id })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-prwf-block">
              <h4>Start prompt<span className="settings-hint">Sent when the workflow starts a new or continued session.</span></h4>
              <textarea
                ref={startPromptRef}
                className="field settings-prwf-textarea"
                value={selected.startPrompt}
                spellCheck={false}
                onChange={(e) => updateSelectedWorkflow({ startPrompt: e.target.value })}
              />
              <div className="settings-prwf-vars">
                {TEMPLATE_VARS.map((v) => (
                  <button key={v} type="button" className="settings-prwf-var" onClick={() => insertTemplateVar("startPrompt", selected, v)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-prwf-block">
              <h4>Follow-up prompt<span className="settings-hint">Sent from the update card for sessions linked to this PR.</span></h4>
              <textarea
                ref={updatePromptRef}
                className="field settings-prwf-textarea"
                value={selected.updatePrompt}
                spellCheck={false}
                onChange={(e) => updateSelectedWorkflow({ updatePrompt: e.target.value })}
              />
              <div className="settings-prwf-vars">
                {TEMPLATE_VARS.map((v) => (
                  <button key={v} type="button" className="settings-prwf-var" onClick={() => insertTemplateVar("updatePrompt", selected, v)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </section>
          </div>
        ) : (
          <div className="side-empty">No workflows configured.</div>
        )}
      </div>
    );
  })();

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
              className={`settings-nav-item${category === "updates" ? " active" : ""}`}
              onClick={() => setCategory("updates")}
              aria-current={category === "updates"}
            >
              Updates
            </button>
            <button
              className={`settings-nav-item${category === "sourceControl" ? " active" : ""}`}
              onClick={() => setCategory("sourceControl")}
              aria-current={category === "sourceControl"}
            >
              Source Control
            </button>
            <button
              className={`settings-nav-item${category === "prWorkflows" ? " active" : ""}`}
              onClick={() => setCategory("prWorkflows")}
              aria-current={category === "prWorkflows"}
            >
              <GitPullRequest size={14} aria-hidden="true" /> PR workflows
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
            {!loading && !loadError && draft && category === "general" && (
              <>
                {generalFields}
                {tabFields}
                {holdingFields}
                <section className="settings-section" aria-label="About cw-code">
                  <h3>About</h3>
                  <div className="settings-brand">
                    <img src={appIcon} alt="" aria-hidden="true" draggable={false} />
                    <div>
                      <strong>cw-code</strong>
                      <span>Version {appVersion} · MIT License</span>
                    </div>
                  </div>
                  <p>{appDescription}</p>
                  <p className="settings-brand-description">Uses your installed CLIs and their authentication.</p>
                </section>
              </>
            )}
            {!loading && !loadError && draft && category === "updates" && <UpdatesSettings draft={draft} fallbackVersion={appVersion} onDraftChange={set} />}
            {!loading && !loadError && draft && category === "sourceControl" && sourceControlFields}
            {!loading && !loadError && draft && category === "prWorkflows" && prWorkflowsFields}
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
