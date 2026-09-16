import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  AtSign,
  Image,
  Lock,
  LockOpen,
  Paperclip,
  Pencil,
  Slash,
  Square,
  Terminal,
  X,
  Zap
} from "lucide-react";
import type { ComposerPrefs, DriverName, EffortLevel, ModelOption, PermissionMode } from "../cw.js";
import { firstDisplayedModelId, getLastModel, setLastModel } from "./lastModel.js";
import { DriverIcon } from "./DriverIcon.js";
import { MenuSelect, type MenuOption } from "./MenuSelect.js";
import { ImageThumb } from "./ImageThumb.js";
import type { ImageTarget } from "./imagePreview.js";

export interface ComposerBackend {
  imageTarget: ImageTarget;
  prefs: ComposerPrefs;
  busy: boolean;
  loadModels(): Promise<ModelOption[]>;
  loadFiles(): Promise<string[]>;
  savePrefs(prefs: ComposerPrefs): void;
  send(body: string, attachments: string[]): Promise<void>;
  savePasteImage(mime: string, data: Uint8Array): Promise<string>;
  interrupt(): void;
}

const EFFORTS: Array<{ id: EffortLevel; label: string }> = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" }
];

const EFFORT_RANK: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortOptionsFor(driver: DriverName, models: ModelOption[], modelId?: string): Array<{ id: EffortLevel; label: string }> {
  if (driver !== "opencode") return EFFORTS;
  if (!modelId) return EFFORTS;
  const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  if (!model || model.variants === undefined) return EFFORTS;
  if (model.variants.length === 0) return EFFORTS.filter((e) => e.id === "high");
  const available = new Set(model.variants.map((v) => v.toLowerCase()));
  return EFFORTS.filter((e) => available.has(e.id) || (e.id === "medium" && available.has("balanced")));
}

function fallbackEffort(current: EffortLevel, available: Array<{ id: EffortLevel; label: string }>): EffortLevel {
  if (available.some((o) => o.id === current)) return current;
  const want = EFFORT_RANK.indexOf(current);
  const below = available.filter((o) => EFFORT_RANK.indexOf(o.id) <= want).sort((a, b) => EFFORT_RANK.indexOf(b.id) - EFFORT_RANK.indexOf(a.id));
  if (below.length > 0) return below[0].id;
  return available[0].id;
}

const PERMISSIONS: Array<{ id: PermissionMode; label: string; description: string; icon: ReactNode }> = [
  { id: "manual", label: "Supervised", description: "Ask before commands and file changes.", icon: <Lock size={14} /> },
  { id: "acceptEdits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", icon: <Pencil size={14} /> },
  { id: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask.", icon: <Zap size={14} /> },
  { id: "bypassPermissions", label: "Full access", description: "Allow commands and edits without prompts.", icon: <LockOpen size={14} /> }
];

function EffortIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 9h14M7 5.5v6M13 9v5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function groupModelsByProvider(models: ModelOption[]): MenuOption[] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const slash = m.id.indexOf("/");
    const provider = slash >= 0 ? m.id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    list.push(m);
    groups.set(provider, list);
  }
  const out: MenuOption[] = [];
  for (const [provider, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ id: `__sep:${provider}`, label: provider, separator: true });
    for (const m of list) out.push({ id: m.id, label: m.label, hint: m.id });
  }
  return out;
}

function isImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function ComposerView({
  backend,
  driver,
  resetKey,
  modelsRefreshKey = 0,
  recipePrefix,
  footer
}: {
  backend: ComposerBackend;
  driver: DriverName;
  resetKey: string;
  modelsRefreshKey?: number;
  recipePrefix?: ReactNode;
  footer?: ReactNode;
}) {
  const { prefs, busy } = backend;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const imageTarget = backend.imageTarget;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (busy) return;
    const frame = requestAnimationFrame(() => {
      try {
        composerRef.current?.focus({ preventScroll: true });
      } catch {
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey, busy]);

  useEffect(() => {
    setAttachments([]);
    setDraft("");
    setPasteError(null);
    setShowCustom(false);
    setCustomModel("");
    setAddOpen(false);
    setPickerOpen(false);
  }, [resetKey]);

  useEffect(() => {
    let cancelled = false;
    setModelsError(null);
    backendRef.current
      .loadModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        if (!prefs.model) {
          const last = getLastModel(driver);
          const next = (last && list.some((m) => m.id === last) ? last : undefined) ?? firstDisplayedModelId(driver, list);
          if (next) backendRef.current.savePrefs({ model: next });
          setShowCustom(false);
        } else if (list.some((m) => m.id === prefs.model)) {
          setLastModel(driver, prefs.model);
          setShowCustom(false);
        } else {
          setCustomModel(prefs.model);
          setShowCustom(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : "model list failed");
      });
    return () => {
      cancelled = true;
    };
  }, [resetKey, driver, prefs.model, modelsRefreshKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    setFilesLoading(true);
    backendRef.current
      .loadFiles()
      .then((list) => setFiles(list))
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false));
  }, [pickerOpen, resetKey]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list.slice(0, 50);
  }, [files, filter]);

  const addAttachment = (rel: string) => {
    setAttachments((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
  };

  const send = () => {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || busy) return;
    const tagged = attachments.length > 0 ? `${body}${body ? "\n" : ""}${attachments.map((a) => `@${a}`).join("\n")}` : body;
    void backend.send(tagged, attachments).then(() => {
      setDraft("");
      setAttachments([]);
      setPasteError(null);
    });
  };

  const pasteFiles = async (clipboard: DataTransfer): Promise<void> => {
    const fromItems = Array.from(clipboard.items)
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    const pasted = fromItems.length > 0 ? fromItems : Array.from(clipboard.files).filter((f) => f.type.startsWith("image/"));
    for (const file of pasted) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const rel = await backendRef.current.savePasteImage(file.type, data);
        addAttachment(rel);
        setPasteError(null);
      } catch (err) {
        setPasteError((err as Error).message || "paste failed");
      }
    }
  };

  const openFilePicker = () => {
    setAddOpen(false);
    setPickerOpen(true);
  };

  const modelValue = showCustom ? "__custom" : (prefs.model ?? "");
  const modelDisplay = showCustom
    ? customModel.trim() || "Custom"
    : (models.find((m) => m.id === prefs.model)?.label ?? "Select model");
  const effortOptions = useMemo(
    () => effortOptionsFor(driver, models, showCustom ? undefined : prefs.model),
    [driver, models, showCustom, prefs.model]
  );
  const effectiveEffort = prefs.effort ?? "medium";
  const effortDisplay = EFFORTS.find((o) => o.id === effectiveEffort)?.label ?? "Medium";

  useEffect(() => {
    if (driver !== "opencode" || showCustom) return;
    if (effortOptions.some((o) => o.id === effectiveEffort)) return;
    backendRef.current.savePrefs({ effort: fallbackEffort(effectiveEffort, effortOptions) });
  }, [driver, showCustom, models, prefs.model, effectiveEffort, effortOptions]);
  useEffect(() => {
    if (!prefs.model || showCustom) return;
    if (!models.some((m) => m.id === prefs.model)) return;
    setLastModel(driver, prefs.model);
  }, [driver, prefs.model, models, showCustom]);
  const permissionDisplay = PERMISSIONS.find((o) => o.id === (prefs.permissionMode ?? "auto"))?.label ?? "Auto";
  const permissionIcon = PERMISSIONS.find((o) => o.id === (prefs.permissionMode ?? "auto"))?.icon;

  return (
    <>
    <div className="composer composer-recipe">
      {attachments.length > 0 && (
        <div className="attach-chips">
          {attachments.map((a) => (
            <span key={a} className="chip" title={a}>
              {isImage(a) ? (
                <ImageThumb target={imageTarget} path={a} className="chip-thumb" />
              ) : (
                <>
                  <span aria-hidden>@</span>
                  <span className="chip-name">{a}</span>
                </>
              )}
              <button
                className="chip-x"
                aria-label={`Remove ${a}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x !== a))}
              >
                <X aria-hidden="true" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-writing">
        <div className="composer-input-wrap">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
                e.preventDefault();
                setPickerOpen(false);
                setAddOpen((v) => !v);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              void pasteFiles(e.clipboardData);
            }}
            placeholder="Ask cw-code — @ files, / commands, $ skills"
            className="composer-input"
            rows={3}
            disabled={busy}
          />
        </div>
      </div>
      {pasteError && (
        <div className="composer-paste-error" role="alert">
          {pasteError}
        </div>
      )}
      {pickerOpen && (
        <div className="attach-picker">
          <input
            className="field"
            placeholder="Filter files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="attach-list">
            {filesLoading && <div className="side-empty">Loading files…</div>}
            {!filesLoading && filtered.length === 0 && <div className="side-empty">No files match.</div>}
            {filtered.map((f) => (
              <div
                key={f}
                className="file-row"
                onClick={() => {
                  addAttachment(f);
                  setPickerOpen(false);
                  setFilter("");
                }}
                title={f}
              >
                {isImage(f) ? <Image aria-hidden="true" size={14} /> : "@ "}
                {f}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="composer-recipe-row">
        {recipePrefix}
        <div className="recipe-control recipe-model" title={driver}>
          <MenuSelect
            label="Model"
            icon={<DriverIcon driver={driver} size={16} />}
            title={modelsError ? `Model list failed: ${modelsError}` : "Model"}
            value={modelValue}
            display={modelDisplay}
            isSet={showCustom || !!prefs.model}
            searchable
            searchPlaceholder="Filter models…"
            options={[
              ...(driver === "opencode"
                ? groupModelsByProvider(models)
                : models.map((m) => ({ id: m.id, label: m.label, hint: m.id }))),
              { id: "__custom", label: "Custom…" }
            ]}
            onPick={(v) => {
              if (v === "__custom") {
                setShowCustom(true);
                return;
              }
              setShowCustom(false);
              if (v) setLastModel(driver, v);
              backend.savePrefs({ model: v || undefined });
            }}
          />
        </div>
        {showCustom && (
          <input
            className="field composer-custom"
            placeholder="provider/model or alias"
            aria-label="Custom model"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => {
              const v = customModel.trim();
              if (v) backend.savePrefs({ model: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setShowCustom(false);
            }}
          />
        )}
        <div className="recipe-control">
          <MenuSelect
            label="Effort"
            icon={<EffortIcon />}
            title="Effort"
            value={prefs.effort ?? "medium"}
            display={effortDisplay}
            isSet={(prefs.effort ?? "medium") !== "medium"}
            options={effortOptions.map((o) => ({ id: o.id, label: o.label }))}
            onPick={(v) => backend.savePrefs({ effort: v as EffortLevel })}
          />
        </div>
        <div className="recipe-control">
          <MenuSelect
            label="Permission"
            icon={permissionIcon}
            title="Permission"
            value={prefs.permissionMode ?? "auto"}
            display={permissionDisplay}
            isSet={(prefs.permissionMode ?? "auto") !== "auto"}
            options={PERMISSIONS.map((o) => ({ id: o.id, label: o.label, description: o.description, icon: o.icon }))}
            onPick={(v) => backend.savePrefs({ permissionMode: v as PermissionMode })}
          />
        </div>
        <div className="menu composer-add">
          <button
            className="icon-btn composer-attach"
            title="Add attachment (Ctrl+U)"
            aria-label="Add attachment"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => {
              setPickerOpen(false);
              setAddOpen((v) => !v);
            }}
          >
            <Paperclip size={17} />
          </button>
          {addOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setAddOpen(false)} />
              <div
                className="menu-panel"
                role="menu"
                aria-label="Add attachment"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAddOpen(false);
                }}
              >
                <div className="menu-row" role="menuitem" title="Attach project files or images as @mentions" onClick={openFilePicker}>
                  <span className="menu-icon">
                    <Image size={14} />
                  </span>
                  <span className="menu-text">
                    <span className="name">Images and files</span>
                  </span>
                  <span className="menu-hint">Ctrl+U</span>
                </div>
                <div className="menu-row" role="menuitem" title="Attach project files as @mentions" onClick={openFilePicker}>
                  <span className="menu-icon">
                    <AtSign size={14} />
                  </span>
                  <span className="menu-text">
                    <span className="name">Context</span>
                  </span>
                  <span className="menu-hint">@</span>
                </div>
                <div className="menu-row disabled" role="menuitem" aria-disabled="true" title="Slash commands are not supported yet">
                  <span className="menu-icon">
                    <Slash size={14} />
                  </span>
                  <span className="menu-text">
                    <span className="name">Commands</span>
                  </span>
                  <span className="menu-hint">/</span>
                </div>
                <div className="menu-row disabled" role="menuitem" aria-disabled="true" title="Shell commands are not supported yet">
                  <span className="menu-icon">
                    <Terminal size={14} />
                  </span>
                  <span className="menu-text">
                    <span className="name">Shell command</span>
                  </span>
                  <span className="menu-hint">!</span>
                </div>
              </div>
            </>
          )}
        </div>
        {busy ? (
          <button
            type="button"
            className="composer-action composer-stop"
            onClick={() => backend.interrupt()}
            title="Stop response"
            aria-label="Stop response"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="composer-action composer-send"
            onClick={send}
            disabled={!draft.trim() && attachments.length === 0}
            title="Send"
            aria-label="Send"
          >
            <ArrowRight size={18} />
          </button>
        )}
      </div>
    </div>
    {footer}
    </>
  );
}
