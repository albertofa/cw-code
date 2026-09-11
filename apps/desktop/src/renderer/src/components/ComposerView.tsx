import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AtSign, ClipboardList, Image, Lock, LockOpen, Pencil, Plus, Slash, Terminal, Zap } from "lucide-react";
import type { ComposerPrefs, DriverName, EffortLevel, ModelOption, PermissionMode } from "../cw.js";
import { DriverIcon } from "./DriverIcon.js";
import { MenuSelect } from "./MenuSelect.js";

export interface ComposerBackend {
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
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" }
];

const PERMISSIONS: Array<{ id: PermissionMode; label: string; description: string; icon: ReactNode }> = [
  { id: "manual", label: "Supervised", description: "Ask before commands and file changes.", icon: <Lock size={14} /> },
  { id: "acceptEdits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", icon: <Pencil size={14} /> },
  { id: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask.", icon: <Zap size={14} /> },
  { id: "bypassPermissions", label: "Full access", description: "Allow commands and edits without prompts.", icon: <LockOpen size={14} /> },
  { id: "plan", label: "Plan", description: "Review and approve a plan before anything runs.", icon: <ClipboardList size={14} /> }
];

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function isImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function ComposerView({
  backend,
  driver,
  resetKey,
  modelsRefreshKey = 0
}: {
  backend: ComposerBackend;
  driver: DriverName;
  resetKey: string;
  modelsRefreshKey?: number;
}) {
  const { prefs, busy } = backend;
  const backendRef = useRef(backend);
  backendRef.current = backend;
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
        if (prefs.model && !list.some((m) => m.id === prefs.model)) {
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
    : (models.find((m) => m.id === prefs.model)?.label ?? "Default model");
  const effortDisplay = EFFORTS.find((o) => o.id === (prefs.effort ?? "medium"))?.label ?? "Medium";
  const permissionDisplay = PERMISSIONS.find((o) => o.id === (prefs.permissionMode ?? "auto"))?.label ?? "Auto";

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attach-chips">
          {attachments.map((a) => (
            <span key={a} className="chip" title={a}>
              <span aria-hidden>{isImage(a) ? "◈" : "@"}</span>
              <span className="chip-name">{a}</span>
              <button
                className="chip-x"
                aria-label={`Remove ${a}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x !== a))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        <textarea
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
          placeholder="Ask for changes, send follow-ups, or attach images"
          className="composer-input"
          rows={2}
          disabled={busy}
        />
        {!draft && attachments.length === 0 && (
          <div className="composer-empty-hint" aria-hidden="true">
            <kbd>⇧</kbd>
            <kbd>↵</kbd>
            <span>newline</span>
          </div>
        )}
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
                {isImage(f) ? "◈ " : "@ "}
                {f}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="composer-bar">
        <span title={driver}>
          <DriverIcon driver={driver} size={13} />
        </span>
        <MenuSelect
          label="Model"
          title={modelsError ? `Model list failed: ${modelsError}` : "Model"}
          value={modelValue}
          display={modelDisplay}
          isSet={showCustom || !!prefs.model}
          searchable
          searchPlaceholder="Filter models…"
          options={[
            ...(!showCustom && !prefs.model ? [{ id: "", label: "Default model" }] : []),
            ...models.map((m) => ({ id: m.id, label: m.label, hint: m.id })),
            { id: "__custom", label: "Custom…" }
          ]}
          onPick={(v) => {
            if (v === "__custom") {
              setShowCustom(true);
              return;
            }
            setShowCustom(false);
            backend.savePrefs({ model: v || undefined });
          }}
        />
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
        <MenuSelect
          label="Effort"
          title="Effort"
          value={prefs.effort ?? "medium"}
          display={effortDisplay}
          isSet={(prefs.effort ?? "medium") !== "medium"}
          options={EFFORTS.map((o) => ({ id: o.id, label: o.label }))}
          onPick={(v) => backend.savePrefs({ effort: v as EffortLevel })}
        />
        <MenuSelect
          label="Permission"
          title="Permission"
          value={prefs.permissionMode ?? "auto"}
          display={permissionDisplay}
          isSet={(prefs.permissionMode ?? "auto") !== "auto"}
          options={PERMISSIONS.map((o) => ({ id: o.id, label: o.label, description: o.description, icon: o.icon }))}
          onPick={(v) => backend.savePrefs({ permissionMode: v as PermissionMode })}
        />
        <div className="menu composer-add">
          <button
            className="icon-btn"
            title="Add attachment (Ctrl+U)"
            aria-label="Add attachment"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => {
              setPickerOpen(false);
              setAddOpen((v) => !v);
            }}
          >
            <Plus size={14} />
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
          <button className="btn btn-stop" onClick={() => backend.interrupt()}>
            Stop
          </button>
        ) : (
          <button className="btn-send-circle" onClick={send} disabled={!draft.trim() && attachments.length === 0} title="Send" aria-label="Send">
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
