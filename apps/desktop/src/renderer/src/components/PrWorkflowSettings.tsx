import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Copy, Folder, FolderGit2, GitFork, GitPullRequest, GripVertical, History, Pencil, Plus, RefreshCw, RotateCcw, Trash2, type LucideIcon } from "lucide-react";
import type { PrSuggestCondition, PrWorkflow, PrWorkflowIcon, PrWorkspaceChoice } from "@cw-code/contracts";
import type { AppSettings, PrDetail, PrSummary } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { errorMessage } from "./errorMessage.js";
import { MenuSelect } from "./MenuSelect.js";
import { useNotifs } from "./Notifications.js";
import { prKey } from "./prInbox.js";
import { needsFailedLogs } from "./prSessionModel.js";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, insertAtCursor, moveWorkflow, moveWorkflowTo, resetWorkflowTo } from "./prWorkflowEditor.js";
import { attributionText, loadFailedLogs, resolveTemplate, TEMPLATE_VARS, templateVars } from "./prWorkflows.js";
import { SettingsPageHead, SettingsSwitch } from "./SettingsLayout.js";
import { harnessLabel } from "./toolTabs.js";
import { WORKFLOW_ICONS } from "./workflowIcons.js";

const CONDITION_LABELS: Record<PrSuggestCondition, string> = {
  "review-requested": "Review requested from me",
  author: "I'm the author",
  "checks-failing": "Checks failing",
  "changes-requested": "Changes requested",
  conflicts: "Has conflicts",
  "bot-author": "Author is a bot",
  draft: "Draft"
};

const ALL_CONDITIONS: PrSuggestCondition[] = ["review-requested", "author", "checks-failing", "changes-requested", "conflicts", "bot-author", "draft"];

const WORKSPACE_OPTIONS: Array<{ id: PrWorkspaceChoice; label: string; hint: string; Icon: LucideIcon }> = [
  { id: "checkout", label: "Current checkout", hint: "Use the project folder as-is.", Icon: Folder },
  { id: "worktree", label: "Worktree at PR head", hint: "Check the PR head out into a new worktree.", Icon: GitFork },
  { id: "linked", label: "Linked session's workspace", hint: "Reuse it; falls back to a worktree.", Icon: History }
];

const ICON_IDS = Object.keys(WORKFLOW_ICONS) as PrWorkflowIcon[];

const NO_PRS: PrSummary[] = [];

type PromptField = "startPrompt" | "updatePrompt";

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
        {workflows.map((w, index) => {
          const Icon = WORKFLOW_ICONS[w.icon];
          const selected = w.id === selectedId;
          const over = overId === w.id && dragId !== null && dragId !== w.id;
          return (
            <div
              key={w.id}
              data-glide-id={w.id}
              className={`sp-wf${selected ? " on" : ""}${dragId === w.id ? " dragging" : ""}${over ? (index > dragIndex ? " over-after" : " over-before") : ""}`}
              onDragOver={(e) => {
                if (!dragId) return;
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
        {workflows.length === 0 && <p className="sp-hint">No workflows configured.</p>}
      </div>
    </div>
  );
}

function IconPicker({ value, onPick }: { value: PrWorkflowIcon; onPick: (icon: PrWorkflowIcon) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = WORKFLOW_ICONS[value];
  return (
    <span className="sp-icon-pick">
      <button type="button" className="sp-wf-ic lg" aria-haspopup="listbox" aria-expanded={open} aria-label={`Workflow icon: ${value}`} title="Change the icon" onClick={() => setOpen((o) => !o)}>
        <Icon size={18} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div
            className="menu-panel menu-panel-down sp-icon-pop"
            role="listbox"
            aria-label="Workflow icon"
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            {ICON_IDS.map((id) => {
              const Option = WORKFLOW_ICONS[id];
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

function PromptPreview({ template, prs, prKeyValue, onPickPr, settings }: { template: string; prs: PrSummary[]; prKeyValue: string | null; onPickPr: (key: string) => void; settings: AppSettings }) {
  const inboxError = usePrStore((s) => s.inboxError);
  const inboxLoading = usePrStore((s) => s.inboxLoading);
  const refreshInbox = usePrStore((s) => s.refreshInbox);
  const loadDetail = usePrStore((s) => s.loadDetail);
  const lastDriver = useAppStore((s) => s.lastDriver);
  const selected = prs.find((pr) => prKey(pr.ref) === prKeyValue) ?? prs[0];
  const key = selected ? prKey(selected.ref) : null;
  const detail: PrDetail | undefined = usePrStore((s) => (key ? s.detailByKey[key] : undefined));
  const detailError = usePrStore((s) => (key ? s.detailErrorByKey[key] : undefined));
  const detailLoading = usePrStore((s) => (key ? s.detailLoadingByKey[key] === true : false));
  const needsLogs = needsFailedLogs(template);
  const [logs, setLogs] = useState<{ id: string; text: string; error: string | null } | null>(null);
  const logsId = detail ? `${prKey(detail.ref)}@${detail.headRefOid}` : null;

  useEffect(() => {
    if (selected && !detail && !detailLoading && !detailError) void loadDetail(selected.ref);
  }, [key]);

  useEffect(() => {
    if (!needsLogs || !detail || !logsId || logs?.id === logsId) return;
    let active = true;
    loadFailedLogs(detail)
      .then((text) => {
        if (active) setLogs({ id: logsId, text, error: null });
      })
      .catch((err: unknown) => {
        if (active) setLogs({ id: logsId, text: "", error: errorMessage(err) });
      });
    return () => {
      active = false;
    };
  }, [needsLogs, logsId]);

  if (prs.length === 0) {
    return (
      <div className="sp-code sp-preview-empty" role={inboxError ? "alert" : undefined}>
        {inboxLoading ? "Loading pull requests…" : inboxError ? `Could not load pull requests: ${inboxError}` : "No pull requests to preview with"}
        {inboxError && !inboxLoading && (
          <button type="button" className="btn sp-btn-sm" onClick={() => void refreshInbox(true)}>
            <RefreshCw size={12} aria-hidden="true" /> Retry
          </button>
        )}
      </div>
    );
  }

  const harness = harnessLabel(lastDriver);
  const logsReady = !needsLogs || logs?.id === logsId;
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
      {logs?.id === logsId && logs?.error && (
        <div className="settings-error sp-preview-error" role="alert">
          Could not load failed check logs: {logs.error}
        </div>
      )}
      <pre className="sp-code sp-preview" aria-label="Resolved prompt" tabIndex={0}>
        {text ?? (detailError ? "" : !detail ? "Loading pull request…" : "Loading failed check logs…")}
      </pre>
    </>
  );
}

function PromptBox({
  title,
  hint,
  field,
  workflow,
  onChange,
  preview
}: {
  title: string;
  hint: string;
  field: PromptField;
  workflow: PrWorkflow;
  onChange: (patch: Partial<PrWorkflow>) => void;
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
            {TEMPLATE_VARS.map((v) => (
              <button key={v} type="button" className="sp-var" onClick={() => insert(v)}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </>
      ) : (
        preview(value)
      )}
    </div>
  );
}

function WorkflowEditor({ workflow, settings, onChange, onDuplicate, onDelete, onReset, resetBusy, resetError }: {
  workflow: PrWorkflow;
  settings: AppSettings;
  onChange: (patch: Partial<PrWorkflow>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onReset: () => void;
  resetBusy: boolean;
  resetError: string | null;
}) {
  const prs = usePrStore((s) => s.inbox?.items ?? NO_PRS);
  const [previewPr, setPreviewPr] = useState<string | null>(null);
  const preview = (template: string) => <PromptPreview template={template} prs={prs} prKeyValue={previewPr} onPickPr={setPreviewPr} settings={settings} />;

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
              <button type="button" className="btn sp-btn-sm" disabled={resetBusy} onClick={onReset}>
                <RotateCcw size={12} aria-hidden="true" /> {resetBusy ? "Resetting…" : "Reset to default"}
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
      <div className="sp-ed-grid">
        <fieldset className="sp-fieldset">
          <legend className="sp-h6">
            Suggest when <small>Shown as the row's primary action and at the top of the workflow menu.</small>
          </legend>
          <div className="sp-cbgrid">
            {ALL_CONDITIONS.map((c) => (
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
            {WORKSPACE_OPTIONS.map((opt) => (
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
      <div className="sp-prompts">
        <PromptBox
          key={`${workflow.id}:start`}
          title="Start prompt"
          hint="Sent when the workflow starts or continues a session."
          field="startPrompt"
          workflow={workflow}
          onChange={onChange}
          preview={preview}
        />
        <PromptBox
          key={`${workflow.id}:update`}
          title="Follow-up prompt"
          hint="Sent from the update card for linked sessions."
          field="updatePrompt"
          workflow={workflow}
          onChange={onChange}
          preview={preview}
        />
      </div>
    </div>
  );
}

export function PrWorkflowSettings() {
  const draft = useSettingsDraftStore((s) => s.draft);
  const set = useSettingsDraftStore((s) => s.set);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    const prStore = usePrStore.getState();
    if (!prStore.inbox && !prStore.inboxLoading) void prStore.refreshInbox();
  }, []);

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

  const reset = async () => {
    if (!selected) return;
    const id = selected.id;
    setResetBusyId(id);
    setResetError(null);
    try {
      const defaults = await window.cw.getDefaultPrWorkflows();
      const current = useSettingsDraftStore.getState().draft;
      if (current) set({ prWorkflows: resetWorkflowTo(current.prWorkflows, id, defaults) });
    } catch (err) {
      const message = errorMessage(err) || "Could not reset workflow";
      setResetError(message);
      useNotifs.getState().push({ kind: "error", title: "Could not reset workflow", message });
    } finally {
      setResetBusyId(null);
    }
  };

  return (
    <>
      <SettingsPageHead title="PR workflows" description="Actions offered on pull requests in the inbox, the PR view and the update card." />
      <div className="sp-strip">
        <div className="sp-strip-col">
          <h2>
            <FolderGit2 size={13} aria-hidden="true" /> Repositories
          </h2>
          <label className="sp-strip-lab" htmlFor="sp-clone-root">
            Clone root
          </label>
          <input id="sp-clone-root" className="field sp-mono-field" value={draft.prCloneRoot} placeholder="~/.cw-code/repos" onChange={(e) => set({ prCloneRoot: e.target.value })} />
          <small>
            PRs from repos that aren't projects yet clone to <span className="sp-mono">&lt;root&gt;/&lt;owner&gt;/&lt;repo&gt;</span>.
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
            <span className="sp-mono">{"{{harness}}"}</span> is the CLI name. Preview: <span className="sp-strong">{attributionText(draft, "Claude") || "nothing (attribution is off)"}</span>
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
            onReset={() => void reset()}
            resetBusy={resetBusyId === selected.id}
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
