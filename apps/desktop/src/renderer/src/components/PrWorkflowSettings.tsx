import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertTriangle, Bot, Copy, Folder, FolderGit2, Gauge, GitFork, GitPullRequest, GripVertical, History, Pencil, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, type LucideIcon } from "lucide-react";
import type { PrSuggestCondition, PrWorkflow, PrWorkflowHarness, PrWorkflowIcon, PrWorkspaceChoice } from "@cw-code/contracts";
import type { AppSettings, DriverName, PrDetail, PrSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { errorMessage } from "./errorMessage.js";
import { MenuSelect } from "./MenuSelect.js";
import { PromptPreviewSkeleton } from "./GitHubSkeletons.js";
import { isHarnessSkipped } from "./harnessAvailability.js";
import { InlineLoading } from "./Loading.js";
import { EFFORTS, effortLabel, effortOptionsFor } from "./modelMenus.js";
import { useNotifs } from "./Notifications.js";
import { prKey } from "./prInbox.js";
import { needsFailedLogs } from "./prSessionModel.js";
import {
  changeWorkflowTarget,
  CONDITIONS_BY_TARGET,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  foreignVarsMessage,
  groupWorkflowsByTarget,
  insertAtCursor,
  moveWorkflow,
  moveWorkflowTo,
  resetWorkflowTemplateTo,
  resetWorkflowTo,
  TARGET_HEADINGS,
  templateVarIssues,
  unknownVarsMessage,
  WORKFLOW_TARGETS,
  type TemplateVarIssues,
  type WorkflowTarget
} from "./prWorkflowEditor.js";
import { attributionText, loadFailedLogs, resolveTemplate, TEMPLATE_VARS_BY_TARGET, templateVars } from "./prWorkflows.js";
import { SettingsPageHead, SettingsSwitch } from "./SettingsLayout.js";
import { HARNESS_IDS, HARNESS_NAMES } from "./settingsSections.js";
import { getRecentModels } from "./lastModel.js";
import { harnessLabel } from "./toolTabs.js";
import { PERMISSION_LABELS, PERMISSION_MODES, workflowDriver, workflowModel } from "./workflowHarness.js";
import { WORKFLOW_ICONS, workflowIcon } from "./workflowIcons.js";

const CONDITION_LABELS: Record<PrSuggestCondition, string> = {
  "review-requested": "Review requested from me",
  author: "I'm the author",
  "checks-failing": "Checks failing",
  "changes-requested": "Changes requested",
  conflicts: "Has conflicts",
  "bot-author": "Author is a bot",
  draft: "Draft",
  "issue-assigned": "Issue assigned to me",
  "issue-bug": "Issue labeled bug",
  "run-failed": "Run failed"
};

type WorkspaceOption = { id: PrWorkspaceChoice; label: string; hint: string; Icon: LucideIcon };

const CHECKOUT_OPTION: WorkspaceOption = { id: "checkout", label: "Current checkout", hint: "No worktree — switches the project folder to the session's branch.", Icon: Folder };

const WORKSPACE_OPTIONS: Record<WorkflowTarget, WorkspaceOption[]> = {
  pr: [
    CHECKOUT_OPTION,
    { id: "worktree", label: "Worktree at PR head", hint: "Check the PR head out into a new worktree.", Icon: GitFork },
    { id: "linked", label: "Linked session's workspace", hint: "Reuse it; falls back to a worktree.", Icon: History }
  ],
  issue: [CHECKOUT_OPTION, { id: "worktree", label: "New worktree", hint: "Start the session in a new isolated worktree.", Icon: GitFork }],
  run: [CHECKOUT_OPTION, { id: "worktree", label: "New worktree", hint: "Start the session in a new isolated worktree.", Icon: GitFork }]
};

const TARGET_SUBJECTS: Record<WorkflowTarget, string> = {
  pr: "this PR",
  issue: "this issue",
  run: "this run"
};

const ICON_IDS = Object.keys(WORKFLOW_ICONS) as PrWorkflowIcon[];

const NO_PRS: PrSummary[] = [];

type ResetScope = "workflow" | PromptField;

type PromptField = "startPrompt" | "updatePrompt";

interface FailedLogsEntry {
  text: string;
  error: string | null;
}

interface FailedLogsCache {
  entries: Record<string, FailedLogsEntry>;
  request: (id: string, detail: PrDetail) => void;
  retry: (id: string, detail: PrDetail) => void;
}

function useFailedLogsCache(): FailedLogsCache {
  const [entries, setEntries] = useState<Record<string, FailedLogsEntry>>({});
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback((id: string, detail: PrDetail) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    loadFailedLogs(detail)
      .then(
        (text): FailedLogsEntry => ({ text, error: null }),
        (err: unknown): FailedLogsEntry => {
          requested.current.delete(id);
          return { text: "", error: errorMessage(err) || "Could not load failed check logs" };
        }
      )
      .then((entry) => {
        if (mounted.current) setEntries((prev) => ({ ...prev, [id]: entry }));
      });
  }, []);

  const retry = useCallback(
    (id: string, detail: PrDetail) => {
      if (requested.current.has(id)) return;
      setEntries((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      request(id, detail);
    },
    [request]
  );

  return { entries, request, retry };
}

function rootDuration(name: string, fallback: number): number {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : fallback;
}

function useReorderGlide(listRef: RefObject<HTMLDivElement | null>, orderKey: string) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-glide-id]"));
    const next = new Map(rows.map((row) => [row.dataset.glideId ?? "", row.offsetTop]));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!reduced && tops.current.size > 0) {
      const duration = rootDuration("--dur-fast", 150);
      const easing = window.getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim() || "ease-out";
      for (const row of rows) {
        const before = tops.current.get(row.dataset.glideId ?? "");
        const after = next.get(row.dataset.glideId ?? "");
        if (before === undefined || after === undefined || before === after) continue;
        row.getAnimations().forEach((animation) => animation.cancel());
        row.animate([{ transform: `translateY(${before - after}px)` }, { transform: "translateY(0)" }], { duration, easing });
      }
    }
    tops.current = next;
  }, [listRef, orderKey]);
}

function suggestHint(workflow: PrWorkflow): string {
  return workflow.suggestWhen.length > 0 ? workflow.suggestWhen.map((c) => CONDITION_LABELS[c]).join(", ") : "Manual only";
}

function WorkflowList({
  workflows,
  selectedId,
  onSelect,
  onChange,
  onAdd
}: {
  workflows: PrWorkflow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (next: PrWorkflow[]) => void;
  onAdd: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  useReorderGlide(listRef, workflows.map((w) => w.id).join("|"));

  const endDrag = () => {
    setDragId(null);
    setOverId(null);
  };

  const onGripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    onChange(moveWorkflow(workflows, id, e.key === "ArrowUp" ? "up" : "down"));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    if (dragId) onChange(moveWorkflowTo(workflows, dragId, targetId));
    endDrag();
  };

  const dragIndex = dragId ? workflows.findIndex((w) => w.id === dragId) : -1;
  const dragTarget = dragIndex >= 0 ? workflows[dragIndex].target : null;

  return (
    <div className="sp-wf-list">
      <div className="sp-wf-list-h">
        <span>
          Workflows <span className="sp-count">{workflows.length}</span>
        </span>
        <button type="button" className="btn sp-btn-sm" onClick={onAdd}>
          <Plus size={12} aria-hidden="true" /> New
        </button>
      </div>
      <div ref={listRef} className="sp-wf-rows">
        {groupWorkflowsByTarget(workflows).map((group) => (
          <Fragment key={group.target}>
            <div className="sp-wf-group" role="heading" aria-level={3}>
              {TARGET_HEADINGS[group.target]}
            </div>
            {group.workflows.map((w) => {
              const index = workflows.indexOf(w);
              const Icon = workflowIcon(w.icon);
              const selected = w.id === selectedId;
              const over = overId === w.id && dragId !== null && dragId !== w.id;
              return (
                <div
                  key={w.id}
                  data-glide-id={w.id}
                  data-workflow-id={w.id}
                  className={`sp-wf${selected ? " on" : ""}${dragId === w.id ? " dragging" : ""}${over ? (index > dragIndex ? " over-after" : " over-before") : ""}`}
                  onDragOver={(e) => {
                    if (!dragId || dragTarget !== w.target) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overId !== w.id) setOverId(w.id);
                  }}
                  onDrop={(e) => onDrop(e, w.id)}
                >
                  <button
                    type="button"
                    className="sp-grip"
                    draggable
                    aria-label={`Reorder ${w.label}`}
                    title="Drag, or use the arrow keys, to reorder"
                    onKeyDown={(e) => onGripKey(e, w.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", w.id);
                      setDragId(w.id);
                    }}
                    onDragEnd={endDrag}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </button>
                  <button type="button" className="sp-wf-main" aria-pressed={selected} onClick={() => onSelect(w.id)}>
                    <span className="sp-wf-ic">
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="sp-wf-b">
                      <b>{w.label}</b>
                      <span>{suggestHint(w)}</span>
                    </span>
                  </button>
                  {!w.builtIn && <span className="sp-tag">custom</span>}
                  <SettingsSwitch
                    checked={w.enabled}
                    onChange={(next) => onChange(workflows.map((item) => (item.id === w.id ? { ...item, enabled: next } : item)))}
                    label={`Enable ${w.label}`}
                  />
                </div>
              );
            })}
          </Fragment>
        ))}
        {workflows.length === 0 && <p className="sp-hint">No workflows configured.</p>}
      </div>
    </div>
  );
}

function IconPicker({ value, onPick }: { value: PrWorkflowIcon; onPick: (icon: PrWorkflowIcon) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const Icon = workflowIcon(value);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="sp-icon-pick">
      <button ref={triggerRef} type="button" className="sp-wf-ic lg" aria-haspopup="listbox" aria-expanded={open} aria-label={`Workflow icon: ${value}`} title="Change the icon" onClick={() => setOpen((o) => !o)}>
        <Icon size={18} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div
            className="menu-panel menu-panel-down sp-icon-pop"
            role="listbox"
            aria-label="Workflow icon"
          >
            {ICON_IDS.map((id) => {
              const Option = workflowIcon(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={id === value}
                  aria-label={id}
                  title={id}
                  className={`sp-icon-opt${id === value ? " on" : ""}`}
                  autoFocus={id === value}
                  onClick={() => {
                    setOpen(false);
                    onPick(id);
                  }}
                >
                  <Option size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </>
      )}
    </span>
  );
}

function PromptPreview({
  template,
  prs,
  prKeyValue,
  onPickPr,
  settings,
  failedLogs,
  driver
}: {
  template: string;
  prs: PrSummary[];
  prKeyValue: string | null;
  onPickPr: (key: string) => void;
  settings: AppSettings;
  failedLogs: FailedLogsCache;
  driver: DriverName;
}) {
  const inboxError = usePrStore((s) => s.inboxError);
  const inboxLoading = usePrStore((s) => s.inboxLoading);
  const refreshInbox = usePrStore((s) => s.refreshInbox);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const selected = prs.find((pr) => prKey(pr.ref) === prKeyValue) ?? prs[0];
  const key = selected ? prKey(selected.ref) : null;
  const detail: PrDetail | undefined = usePrStore((s) => (key ? s.detailByKey[key] : undefined));
  const detailError = usePrStore((s) => (key ? s.detailErrorByKey[key] : undefined));
  const detailLoading = usePrStore((s) => (key ? s.detailLoadingByKey[key] === true : false));
  const needsLogs = needsFailedLogs(template);
  const logsId = detail ? `${prKey(detail.ref)}@${detail.headRefOid}` : null;
  const logs = logsId ? failedLogs.entries[logsId] : undefined;
  const requestLogs = failedLogs.request;

  useEffect(() => {
    if (selected && !detail && !detailLoading && !detailError) void loadDetail(selected.ref);
  }, [key]);

  useEffect(() => {
    if (needsLogs && detail && logsId && !logs) requestLogs(logsId, detail);
  }, [needsLogs, logsId, logs, requestLogs]);

  if (prs.length === 0) {
    return (
      <div className="sp-code sp-preview-empty" role={inboxError ? "alert" : undefined}>
        {inboxLoading ? <InlineLoading label="Loading pull requests" /> : inboxError ? `Could not load pull requests: ${inboxError}` : "No pull requests to preview with"}
        {inboxError && !inboxLoading && (
          <button type="button" className="btn sp-btn-sm" onClick={() => void refreshInbox(true)}>
            <RefreshCw size={12} aria-hidden="true" /> Retry
          </button>
        )}
      </div>
    );
  }

  const harness = harnessLabel(driver);
  const logsReady = !needsLogs || logs !== undefined;
  const text = detail && logsReady ? resolveTemplate(template, templateVars(detail, { attribution: attributionText(settings, harness), harness, failedLogs: needsLogs ? logs?.text : undefined })) : null;

  return (
    <>
      <div className="sp-preview-bar">
        <MenuSelect
          label="Preview pull request"
          title="Pull request used for the preview"
          direction="down"
          value={key ?? ""}
          display={selected ? `${selected.ref.owner}/${selected.ref.repo}#${selected.ref.number} ${selected.title}` : ""}
          icon={<GitPullRequest size={13} aria-hidden="true" />}
          options={prs.map((pr) => ({
            id: prKey(pr.ref),
            label: `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} ${pr.title}`,
            hint: pr.title
          }))}
          onPick={onPickPr}
          searchable
          searchPlaceholder="Filter pull requests…"
        />
        <span className="sp-hint">Harness: {harness}</span>
      </div>
      {detailError && (
        <div className="settings-error sp-preview-error" role="alert">
          Could not load the pull request: {detailError}
          <button type="button" className="btn sp-btn-sm" onClick={() => selected && void loadDetail(selected.ref)} disabled={detailLoading}>
            Retry
          </button>
        </div>
      )}
      {needsLogs && logs?.error && (
        <div className="settings-error sp-preview-error" role="alert">
          Could not load failed check logs: {logs.error}
          <button type="button" className="btn sp-btn-sm" onClick={() => detail && logsId && failedLogs.retry(logsId, detail)}>
            <RefreshCw size={12} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      {text === null && !detailError ? (
        <PromptPreviewSkeleton label={!detail ? "Loading pull request" : "Loading failed check logs"} />
      ) : (
        <pre className="sp-code sp-preview" aria-label="Resolved prompt" tabIndex={0}>
          {text ?? ""}
        </pre>
      )}
    </>
  );
}

function PromptBox({
  title,
  hint,
  field,
  workflow,
  issues,
  onChange,
  onReset,
  resetBusy,
  preview
}: {
  title: string;
  hint: string;
  field: PromptField;
  workflow: PrWorkflow;
  issues: TemplateVarIssues;
  onChange: (patch: Partial<PrWorkflow>) => void;
  onReset: () => void;
  resetBusy: ResetScope | null;
  preview: (template: string) => ReactNode;
}) {
  const [mode, setMode] = useState<"template" | "preview">("template");
  const ref = useRef<HTMLTextAreaElement>(null);
  const value = workflow[field];
  const inputId = `sp-${field}`;

  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = insertAtCursor(value, `{{${token}}}`, start, end);
    onChange(field === "startPrompt" ? { startPrompt: next.value } : { updatePrompt: next.value });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  return (
    <div className="sp-pbox">
      <div className="sp-h6">
        <label htmlFor={inputId}>{title}</label>
        <span className="seg sp-seg-sm" role="group" aria-label={`${title} view`}>
          <button type="button" className={mode === "template" ? "on" : ""} aria-pressed={mode === "template"} onClick={() => setMode("template")}>
            Template
          </button>
          <button type="button" className={mode === "preview" ? "on" : ""} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
            Preview
          </button>
        </span>
        {workflow.builtIn && (
          <button type="button" className="btn sp-btn-sm" disabled={resetBusy !== null} title={`Restore the default ${title.toLowerCase()}`} onClick={onReset}>
            <RotateCcw size={12} aria-hidden="true" /> {resetBusy === field ? "Resetting…" : "Reset"}
          </button>
        )}
        <small>{hint}</small>
      </div>
      {mode === "template" ? (
        <>
          <textarea
            id={inputId}
            ref={ref}
            className="sp-code sp-template"
            value={value}
            spellCheck={false}
            onChange={(e) => onChange(field === "startPrompt" ? { startPrompt: e.target.value } : { updatePrompt: e.target.value })}
          />
          <div className="sp-vars" role="group" aria-label={`Insert a variable into the ${title.toLowerCase()}`}>
            <span>Insert</span>
            {TEMPLATE_VARS_BY_TARGET[workflow.target].map((v) => (
              <button key={v} type="button" className="sp-var" onClick={() => insert(v)}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </>
      ) : (
        preview(value)
      )}
      {issues.foreign.length > 0 && (
        <div className="sp-issue error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> {foreignVarsMessage(issues.foreign, workflow.target)}
        </div>
      )}
      {issues.unknown.length > 0 && (
        <div className="sp-issue warning">
          <AlertTriangle size={13} aria-hidden="true" /> {unknownVarsMessage(issues.unknown)}
        </div>
      )}
    </div>
  );
}

function useHarnessOptions<T>(driver: DriverName | null, load: (driver: DriverName) => Promise<T[]>) {
  const [state, setState] = useState<{ driver: DriverName | null; list: T[] | null; error: string | null }>({ driver, list: null, error: null });

  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    setState({ driver, list: null, error: null });
    load(driver).then(
      (list) => {
        if (!cancelled) setState({ driver, list, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ driver, list: [], error: errorMessage(err) || "Could not load options" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [driver]);

  return state.driver === driver ? state : { driver, list: null, error: null };
}

function WorkflowHarnessFields({ workflow, onChange }: { workflow: PrWorkflow; onChange: (patch: Partial<PrWorkflow>) => void }) {
  const composerDriver = useAppStore((s) => s.pendingDriver ?? s.lastDriver);
  const checks = useSettingsDraftStore((s) => s.harnessChecks);
  const config = workflow.harness;
  const driver = workflowDriver(config, composerDriver);
  const defaultModel = useAppStore((s) => s.defaultModelByDriver[driver]);
  const models = useHarnessOptions(driver, (d) => window.cw.listModelsForHarness(d));
  const permissions = useHarnessOptions(driver, (d) => window.cw.listPermissionsForHarness(d));
  const driverModels = models.list ?? [];
  const modelList = config.driver ? driverModels : [];
  const effectiveModel = workflowModel(config, { defaultModel, recentModels: getRecentModels(driver), models: driverModels });
  const efforts = effortOptionsFor(driver, driverModels, effectiveModel);
  const permissionList = permissions.list && permissions.list.length > 0 ? permissions.list : null;
  const permissionsLoading = permissions.list === null;
  const effortUnsupported = config.effort !== null && !efforts.some((e) => e.id === config.effort);
  const permissionUnsupported = config.permissionMode !== null && permissionList !== null && !permissionList.some((p) => p.id === config.permissionMode);
  const unsupported = (label: string) => `${label} (unsupported, falls back)`;
  const savedModelMissing = config.model !== "" && models.list !== null && !modelList.some((m) => m.id === config.model);
  const setHarness = (patch: Partial<PrWorkflowHarness>) => onChange({ harness: { ...config, ...patch } });
  const status = models.error
    ? `Could not load models: ${models.error}`
    : permissions.error
      ? `Could not load permission modes: ${permissions.error}`
      : null;

  return (
    <fieldset className="sp-fieldset" id={`sp-wf-harness-${workflow.id}`}>
      <legend className="sp-h6">
        Harness <small>Used when the workflow starts a new session. Unset values follow your current composer choice.</small>
      </legend>
      <div className="sp-wf-harness">
        <div className="sp-field">
          <span>Harness</span>
          <MenuSelect
            label="Workflow harness"
            direction="down"
            value={config.driver ?? ""}
            display={config.driver ? HARNESS_NAMES[config.driver] : `Composer default (${HARNESS_NAMES[composerDriver]})`}
            icon={<DriverIcon driver={driver} size={13} />}
            options={[
              { id: "", label: "Composer default", hint: "Composer default", description: `Currently ${HARNESS_NAMES[composerDriver]}` },
              ...HARNESS_IDS.map((id) => {
                const check = checks?.find((item) => item.binary === id);
                const unavailable = check !== undefined && isHarnessSkipped(check);
                return {
                  id,
                  label: HARNESS_NAMES[id],
                  hint: HARNESS_NAMES[id],
                  description: unavailable ? "Not installed" : undefined,
                  disabled: unavailable,
                  icon: <DriverIcon driver={id} size={13} />
                };
              })
            ]}
            onPick={(id) => {
              const next = HARNESS_IDS.find((h) => h === id) ?? null;
              if (next !== config.driver) setHarness({ driver: next, model: "" });
            }}
          />
        </div>
        <div className="sp-field">
          <span>Model</span>
          <MenuSelect
            label="Workflow model"
            direction="down"
            value={config.model}
            display={modelList.find((m) => m.id === config.model)?.label ?? (config.model || "Default")}
            icon={<Bot size={13} aria-hidden="true" />}
            options={[
              {
                id: "",
                label: "Default",
                hint: "Default",
                description: config.driver ? "The harness default, or your most recent model" : "Pick a harness to choose a specific model"
              },
              ...modelList.map((m) => ({ id: m.id, label: m.label, hint: m.id })),
              ...(savedModelMissing ? [{ id: config.model, label: `${config.model} (saved)`, hint: config.model }] : [])
            ]}
            onPick={(id) => setHarness({ model: id })}
            searchable={modelList.length > 5}
            searchPlaceholder="Filter models…"
          />
        </div>
        <div className="sp-field">
          <span>Effort</span>
          <MenuSelect
            label="Workflow effort"
            direction="down"
            value={config.effort ?? ""}
            display={config.effort ? (effortUnsupported ? unsupported(effortLabel(config.effort)) : effortLabel(config.effort)) : "Composer default"}
            icon={<Gauge size={13} aria-hidden="true" />}
            options={[
              { id: "", label: "Composer default", hint: "Composer default" },
              ...efforts.map((e) => ({ id: e.id, label: e.label, hint: e.label })),
              ...(config.effort && effortUnsupported
                ? [{ id: config.effort, label: unsupported(effortLabel(config.effort)), hint: config.effort }]
                : [])
            ]}
            onPick={(id) => setHarness({ effort: EFFORTS.find((e) => e.id === id)?.id ?? null })}
          />
        </div>
        <div className="sp-field">
          <span>Permissions</span>
          <MenuSelect
            label="Workflow permissions"
            direction="down"
            value={config.permissionMode ?? ""}
            display={
              config.permissionMode
                ? permissionUnsupported
                  ? unsupported(PERMISSION_LABELS[config.permissionMode])
                  : (permissionList?.find((p) => p.id === config.permissionMode)?.label ?? PERMISSION_LABELS[config.permissionMode])
                : "Composer default"
            }
            icon={<ShieldCheck size={13} aria-hidden="true" />}
            options={[
              { id: "", label: "Composer default", hint: "Composer default" },
              ...(permissionList ?? PERMISSION_MODES.map((id) => ({ id, label: PERMISSION_LABELS[id], description: "" }))).map((p) => ({
                id: p.id,
                label: p.label,
                hint: p.label,
                description: permissionsLoading ? "Checking what this harness supports…" : p.description || undefined,
                disabled: permissionsLoading
              })),
              ...(config.permissionMode && permissionUnsupported
                ? [{ id: config.permissionMode, label: unsupported(PERMISSION_LABELS[config.permissionMode]), hint: config.permissionMode }]
                : [])
            ]}
            onPick={(id) => setHarness({ permissionMode: PERMISSION_MODES.find((m) => m === id) ?? null })}
          />
        </div>
      </div>
      {status && (
        <div className="sp-issue error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> {status}
        </div>
      )}
    </fieldset>
  );
}

function WorkflowEditor({ workflow, settings, onChange, onDuplicate, onDelete, onReset, resetBusy, resetError }: {
  workflow: PrWorkflow;
  settings: AppSettings;
  onChange: (patch: Partial<PrWorkflow>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onReset: (scope: ResetScope) => void;
  resetBusy: ResetScope | null;
  resetError: string | null;
}) {
  const prs = usePrStore((s) => s.inbox?.items ?? NO_PRS);
  const [previewPr, setPreviewPr] = useState<string | null>(null);
  const failedLogs = useFailedLogsCache();
  const driver = useAppStore((s) => workflowDriver(workflow.harness, s.pendingDriver ?? s.lastDriver));
  const issues = templateVarIssues(workflow);
  const preview = (template: string) =>
    workflow.target === "pr" ? (
      <PromptPreview template={template} prs={prs} prKeyValue={previewPr} onPickPr={setPreviewPr} settings={settings} failedLogs={failedLogs} driver={driver} />
    ) : (
      <div className="sp-code sp-preview-empty">Preview is available for pull request workflows.</div>
    );

  const toggleCondition = (condition: PrSuggestCondition) => {
    const has = workflow.suggestWhen.includes(condition);
    onChange({ suggestWhen: has ? workflow.suggestWhen.filter((c) => c !== condition) : [...workflow.suggestWhen, condition] });
  };

  return (
    <div className="sp-wf-ed">
      <div className="sp-ed-h">
        <IconPicker value={workflow.icon} onPick={(icon) => onChange({ icon })} />
        <div className="sp-ed-fields">
          <input className="field sp-ed-name" value={workflow.label} aria-label="Workflow label" onChange={(e) => onChange({ label: e.target.value })} />
          <input
            className="field"
            value={workflow.description}
            placeholder="Description"
            aria-label="Workflow description"
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </div>
        <div className="sp-ed-actions">
          <span className={`sp-tag${workflow.builtIn ? "" : " custom"}`}>{workflow.builtIn ? "built-in" : "custom"}</span>
          <span className="sp-actions">
            {workflow.builtIn && (
              <button
                type="button"
                className="btn sp-btn-sm"
                disabled={resetBusy !== null}
                title={`Restore every setting of ${workflow.label}`}
                onClick={() => onReset("workflow")}
              >
                <RotateCcw size={12} aria-hidden="true" /> {resetBusy === "workflow" ? "Resetting…" : "Reset workflow"}
              </button>
            )}
            <button type="button" className="btn sp-btn-sm" onClick={onDuplicate}>
              <Copy size={12} aria-hidden="true" /> Duplicate
            </button>
            {!workflow.builtIn && (
              <button type="button" className="btn btn-danger sp-btn-sm" onClick={onDelete}>
                <Trash2 size={12} aria-hidden="true" /> Delete
              </button>
            )}
          </span>
        </div>
      </div>
      {resetError && (
        <div className="settings-error" role="alert">
          {resetError}
        </div>
      )}
      <div className="sp-h6">
        Applies to <small>Which GitHub items this workflow runs on.</small>
        {workflow.builtIn ? (
          <span className="sp-tag sp-target-tag">{TARGET_HEADINGS[workflow.target]}</span>
        ) : (
          <span className="seg sp-seg-sm" role="group" aria-label="Applies to">
            {WORKFLOW_TARGETS.map((t) => (
              <button
                key={t}
                type="button"
                className={workflow.target === t ? "on" : ""}
                aria-pressed={workflow.target === t}
                onClick={() => onChange(changeWorkflowTarget(workflow, t))}
              >
                {TARGET_HEADINGS[t]}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="sp-ed-grid">
        <fieldset className="sp-fieldset">
          <legend className="sp-h6">
            Suggest when <small>Shown as the row's primary action and at the top of the workflow menu.</small>
          </legend>
          <div className="sp-cbgrid">
            {CONDITIONS_BY_TARGET[workflow.target].map((c) => (
              <label key={c} className={`sp-cbl${workflow.suggestWhen.includes(c) ? " on" : ""}`}>
                <input type="checkbox" checked={workflow.suggestWhen.includes(c)} onChange={() => toggleCondition(c)} />
                {CONDITION_LABELS[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="sp-fieldset">
          <legend className="sp-h6">Default workspace</legend>
          <div className="sp-wsopts" role="radiogroup" aria-label="Default workspace">
            {WORKSPACE_OPTIONS[workflow.target].map((opt) => (
              <label key={opt.id} className={`sp-wsopt${workflow.workspace === opt.id ? " on" : ""}`}>
                <input type="radio" name={`sp-workspace-${workflow.id}`} checked={workflow.workspace === opt.id} onChange={() => onChange({ workspace: opt.id })} />
                <span>
                  <b>
                    <opt.Icon size={13} aria-hidden="true" />
                    {opt.label}
                  </b>
                  <small>{opt.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <WorkflowHarnessFields workflow={workflow} onChange={onChange} />
      {workflow.target === "pr" && (
        <fieldset className="sp-fieldset">
          <legend className="sp-h6">
            Follow-ups <small>Applies to sessions started from this workflow.</small>
          </legend>
          <label className={`sp-cbl sp-cbl-row${workflow.autoFollowUp ? " on" : ""}`}>
            <input type="checkbox" checked={workflow.autoFollowUp === true} onChange={(e) => onChange({ autoFollowUp: e.target.checked })} />
            Send the follow-up prompt automatically for failed checks, change requests and comments, until the PR is merged or closed
          </label>
        </fieldset>
      )}
      <div className="sp-prompts">
        <PromptBox
          key={`${workflow.id}:start`}
          title="Start prompt"
          hint="Sent when the workflow starts or continues a session."
          field="startPrompt"
          workflow={workflow}
          issues={issues.startPrompt}
          onChange={onChange}
          onReset={() => onReset("startPrompt")}
          resetBusy={resetBusy}
          preview={preview}
        />
        <PromptBox
          key={`${workflow.id}:update`}
          title="Follow-up prompt"
          hint={`Sent when you continue a session linked to ${TARGET_SUBJECTS[workflow.target]}.`}
          field="updatePrompt"
          workflow={workflow}
          issues={issues.updatePrompt}
          onChange={onChange}
          onReset={() => onReset("updatePrompt")}
          resetBusy={resetBusy}
          preview={preview}
        />
      </div>
    </div>
  );
}

export function PrWorkflowSettings({ focusWorkflowId }: { focusWorkflowId?: string }) {
  const draft = useSettingsDraftStore((s) => s.draft);
  const lastDriver = useAppStore((s) => s.lastDriver);
  const set = useSettingsDraftStore((s) => s.set);
  const invalidWorkflowId = useSettingsDraftStore((s) => s.invalidWorkflowId);
  const clearInvalidWorkflow = useSettingsDraftStore((s) => s.clearInvalidWorkflow);
  const [selectedId, setSelectedId] = useState<string | null>(focusWorkflowId ?? null);
  const [resetBusy, setResetBusy] = useState<{ id: string; scope: ResetScope } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    const prStore = usePrStore.getState();
    if (!prStore.inbox && !prStore.inboxLoading) void prStore.refreshInbox();
  }, []);

  useEffect(() => {
    if (!invalidWorkflowId) return;
    setSelectedId(invalidWorkflowId);
    clearInvalidWorkflow();
    requestAnimationFrame(() => {
      document.querySelector(`[data-workflow-id="${CSS.escape(invalidWorkflowId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }, [invalidWorkflowId, clearInvalidWorkflow]);

  useEffect(() => {
    if (!focusWorkflowId) return;
    setSelectedId(focusWorkflowId);
    requestAnimationFrame(() => {
      document.querySelector(`[data-workflow-id="${CSS.escape(focusWorkflowId)}"]`)?.scrollIntoView({ block: "nearest" });
      document.getElementById(`sp-wf-harness-${focusWorkflowId}`)?.scrollIntoView({ block: "center" });
    });
  }, [focusWorkflowId]);

  if (!draft) return null;
  const workflows = draft.prWorkflows;
  const selected = workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null;
  const setWorkflows = (next: PrWorkflow[]) => set({ prWorkflows: next });

  const updateSelected = (patch: Partial<PrWorkflow>) => {
    if (!selected) return;
    setWorkflows(workflows.map((w) => (w.id === selected.id ? { ...w, ...patch } : w)));
  };

  const add = () => {
    const next = createWorkflow(workflows);
    setWorkflows(next);
    setSelectedId(next[next.length - 1].id);
  };

  const duplicate = () => {
    if (!selected) return;
    const sourceIndex = workflows.findIndex((w) => w.id === selected.id);
    const next = duplicateWorkflow(workflows, selected.id);
    setWorkflows(next);
    const added = next[sourceIndex + 1];
    if (added) setSelectedId(added.id);
  };

  const remove = () => {
    if (!selected) return;
    const index = workflows.findIndex((w) => w.id === selected.id);
    const next = deleteWorkflow(workflows, selected.id);
    setWorkflows(next);
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
  };

  const reset = async (scope: ResetScope) => {
    if (!selected) return;
    const id = selected.id;
    const apply = (current: PrWorkflow[], defaults: PrWorkflow[]) =>
      scope === "workflow" ? resetWorkflowTo(current, id, defaults) : resetWorkflowTemplateTo(current, id, scope, defaults);
    const failure = scope === "workflow" ? "Could not reset workflow" : "Could not reset template";
    setResetBusy({ id, scope });
    setResetError(null);
    try {
      const defaults = await window.cw.getDefaultPrWorkflows();
      const current = useSettingsDraftStore.getState().draft;
      if (current) set({ prWorkflows: apply(current.prWorkflows, defaults) });
    } catch (err) {
      const message = errorMessage(err) || failure;
      setResetError(message);
      useNotifs.getState().push({ kind: "error", title: failure, message });
    } finally {
      setResetBusy(null);
    }
  };

  return (
    <>
      <SettingsPageHead title="Workflows" description="Actions offered on pull requests, issues and workflow runs in the GitHub hub, their detail views and the update card." />
      <div className="sp-strip">
        <div className="sp-strip-col">
          <h2>
            <FolderGit2 size={13} aria-hidden="true" /> Repositories
          </h2>
          <label className="sp-strip-lab" htmlFor="sp-clone-root">
            Clone root
          </label>
          <input id="sp-clone-root" className="field sp-mono-field" value={draft.prCloneRoot} placeholder="~/.cw-code/repos" onChange={(e) => set({ prCloneRoot: e.target.value })} />
          <label className="sp-inline-switch" htmlFor="sp-clone-owner">
            <SettingsSwitch
              id="sp-clone-owner"
              checked={draft.prCloneIncludeOwner}
              onChange={(next) => set({ prCloneIncludeOwner: next })}
              label="Append the owner folder to the clone path"
            />
            Append owner folder
          </label>
          <small>
            PRs from repos that aren't projects yet clone to{" "}
            <span className="sp-mono">&lt;root&gt;{draft.prCloneIncludeOwner ? "/&lt;owner&gt;" : ""}/&lt;repo&gt;</span>.
          </small>
        </div>
        <div className="sp-strip-col">
          <h2>
            <RefreshCw size={13} aria-hidden="true" /> Updates
          </h2>
          <label className="sp-strip-lab" htmlFor="sp-pr-refresh">
            Refresh interval
          </label>
          <span className="sp-number">
            <input
              id="sp-pr-refresh"
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
          <small>How often linked PRs and the inbox refresh. 30–3600.</small>
        </div>
        <div className="sp-strip-col">
          <h2>
            <Pencil size={13} aria-hidden="true" /> Attribution
            <SettingsSwitch checked={draft.prAttributionEnabled} onChange={(next) => set({ prAttributionEnabled: next })} label="Enable attribution" />
          </h2>
          <label className="sp-strip-lab" htmlFor="sp-attribution">
            Sign what the agent posts
          </label>
          <input
            id="sp-attribution"
            className="field sp-mono-field"
            value={draft.prAttributionText}
            disabled={!draft.prAttributionEnabled}
            onChange={(e) => set({ prAttributionText: e.target.value })}
          />
          <small>
            <span className="sp-mono">{"{{harness}}"}</span> is the CLI name. Preview: <span className="sp-strong">{attributionText(draft, harnessLabel(lastDriver)) || "nothing (attribution is off)"}</span>
          </small>
        </div>
      </div>
      <div className="sp-md">
        <WorkflowList workflows={workflows} selectedId={selected?.id ?? null} onSelect={setSelectedId} onChange={setWorkflows} onAdd={add} />
        {selected ? (
          <WorkflowEditor
            workflow={selected}
            settings={draft}
            onChange={updateSelected}
            onDuplicate={duplicate}
            onDelete={remove}
            onReset={(scope) => void reset(scope)}
            resetBusy={resetBusy?.id === selected.id ? resetBusy.scope : null}
            resetError={resetError}
          />
        ) : (
          <div className="sp-wf-ed">
            <p className="sp-hint">No workflows configured. Create one with New.</p>
          </div>
        )}
      </div>
    </>
  );
}
