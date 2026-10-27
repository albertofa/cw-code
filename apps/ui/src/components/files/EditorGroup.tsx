import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { GitBaseline } from "@cw-code/contracts";
import { AlertTriangle, ChevronRight, Eye, FileWarning, Lock, PanelRight, PanelRightClose, Pencil, Save, WrapText, X } from "lucide-react";
import type { FileTab } from "../../files/fileTabs.js";
import { bufferKey, isDirtyBuffer, useEditorBuffers } from "../../stores/editorBuffers.js";
import { CodeEditor, type EditorReveal, type EditorStatus } from "../../editor/CodeEditor.js";
import { resolveLanguage } from "../../editor/languages.js";
import { FileIcon } from "../fileIcons.js";
import { ipcErrorMessage } from "../ipcError.js";
import { Md } from "../Markdown.js";

export type TabView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; readOnlyReason?: "large" | "encoding" }
  | { status: "binary"; size: number }
  | { status: "tooLarge"; size: number }
  | { status: "image" };

export interface PathReveal extends EditorReveal {
  path: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function disambiguators(tabs: FileTab[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const tab of tabs) {
    const name = baseName(tab.path);
    byName.set(name, [...(byName.get(name) ?? []), tab.path]);
  }
  const out = new Map<string, string>();
  for (const paths of byName.values()) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      const parts = path.split("/");
      out.set(path, parts.length > 1 ? parts[parts.length - 2] : "");
    }
  }
  return out;
}

function ImageView({ sessionId, path }: { sessionId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    window.cw
      .readImage({ sessionId, path })
      .then(({ mime, base64 }) => {
        if (!cancelled) setSrc(`data:${mime};base64,${base64}`);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(ipcErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);
  if (error) return <div className="fx-placeholder">Couldn’t load image: {error}</div>;
  if (!src) return <div className="fx-placeholder">Loading image…</div>;
  return (
    <div className="fx-image">
      <img src={src} alt={baseName(path)} />
    </div>
  );
}

export function EditorGroup({
  sessionId,
  tabs,
  active,
  views,
  reveal,
  baselines,
  sideVisible,
  wrap,
  previewing,
  onToggleSide,
  onToggleWrap,
  onTogglePreview,
  onActivate,
  onPin,
  onClose,
  onTabMenu,
  onSave,
  onRevealInTree,
  onResolveConflict,
  onRetry
}: {
  sessionId: string;
  tabs: FileTab[];
  active: string | null;
  views: Record<string, TabView>;
  reveal: PathReveal | null;
  baselines: Record<string, GitBaseline>;
  sideVisible: boolean;
  wrap: boolean;
  previewing: ReadonlySet<string>;
  onToggleSide: () => void;
  onToggleWrap: () => void;
  onTogglePreview: (path: string) => void;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
  onTabMenu: (e: ReactMouseEvent, path: string) => void;
  onSave: (path: string) => void;
  onRevealInTree: (path: string) => void;
  onResolveConflict: (path: string, choice: "reload" | "keepMine") => void;
  onRetry: (path: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const activeKey = active ? bufferKey(sessionId, active) : null;
  const buffer = useEditorBuffers((s) => (activeKey ? s.buffers[activeKey] : undefined));
  const dirtyPaths = useEditorBuffers((s) =>
    tabs
      .filter((tab) => {
        const entry = s.buffers[bufferKey(sessionId, tab.path)];
        return entry !== undefined && isDirtyBuffer(entry);
      })
      .map((tab) => tab.path)
      .join("\n")
  );
  const dirty = new Set(dirtyPaths ? dirtyPaths.split("\n") : []);
  const hints = disambiguators(tabs);
  const view = active ? views[active] : undefined;
  const isText = view?.status === "text" && buffer !== undefined;
  const isMarkdown = active ? isMarkdownPath(active) : false;
  const showPreview = isText && isMarkdown && active !== null && previewing.has(active);
  const language = active ? resolveLanguage(active).label : "";

  useEffect(() => {
    if (!active) setStatus(null);
    stripRef.current?.querySelector<HTMLElement>(".fx-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const segments = active ? active.split("/") : [];

  return (
    <div
      className="fx-group"
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || !active) return;
        if (e.key.toLowerCase() === "w" && !e.shiftKey) {
          e.preventDefault();
          onClose(active);
        } else if (e.key === "PageDown" || e.key === "PageUp") {
          e.preventDefault();
          const index = tabs.findIndex((tab) => tab.path === active);
          const next = tabs[(index + (e.key === "PageDown" ? 1 : -1) + tabs.length) % tabs.length];
          if (next) onActivate(next.path);
        }
      }}
    >
      <div className="fx-tabbar">
        <div ref={stripRef} className="fx-tabs" role="tablist" aria-label="Open files">
          {tabs.map((tab) => {
            const isActive = tab.path === active;
            const isDirty = dirty.has(tab.path);
            const hint = hints.get(tab.path);
            return (
              <div
                key={tab.path}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`fx-tab${isActive ? " active" : ""}${tab.preview ? " preview" : ""}${isDirty ? " dirty" : ""}`}
                title={tab.path}
                onClick={() => onActivate(tab.path)}
                onDoubleClick={() => onPin(tab.path)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onTabMenu(e, tab.path);
                }}
              >
                <FileIcon name={baseName(tab.path)} size={14} />
                <span className="fx-tab-name">{baseName(tab.path)}</span>
                {hint && <span className="fx-tab-hint">{hint}</span>}
                <button
                  type="button"
                  className="fx-tab-close"
                  title={isDirty ? "Unsaved changes — close" : "Close"}
                  aria-label={`Close ${baseName(tab.path)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.path);
                  }}
                >
                  <span className="fx-tab-dot" aria-hidden="true" />
                  <X size={13} className="fx-tab-x" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="fx-icon-btn fx-side-toggle"
          title={sideVisible ? "Hide explorer" : "Show explorer"}
          aria-label={sideVisible ? "Hide explorer" : "Show explorer"}
          aria-pressed={sideVisible}
          onClick={onToggleSide}
        >
          {sideVisible ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
        </button>
      </div>
      {active ? (
        <>
          <div className="fx-crumbs">
            <nav className="fx-crumb-path" aria-label="File path">
              {segments.map((segment, index) => {
                const path = segments.slice(0, index + 1).join("/");
                const last = index === segments.length - 1;
                return (
                  <span key={path} className="fx-crumb">
                    {index > 0 && <ChevronRight size={12} className="fx-crumb-sep" aria-hidden="true" />}
                    <button type="button" className={`fx-crumb-btn${last ? " last" : ""}`} onClick={() => onRevealInTree(path)}>
                      {last && <FileIcon name={segment} size={13} />}
                      {segment}
                    </button>
                  </span>
                );
              })}
            </nav>
            <div className="fx-crumb-actions">
              {buffer?.readOnly && (
                <span
                  className="fx-badge"
                  title={
                    view?.status === "text" && view.readOnlyReason === "encoding"
                      ? "This file isn't valid UTF-8; it opens read-only so saving can't corrupt it"
                      : "Files over 2 MB open read-only"
                  }
                >
                  <Lock size={12} /> Read-only
                </span>
              )}
              {isText && isMarkdown && (
                <button
                  type="button"
                  className={`fx-icon-btn${showPreview ? " on" : ""}`}
                  title={showPreview ? "Edit source" : "Open preview"}
                  aria-pressed={showPreview}
                  onClick={() => onTogglePreview(active)}
                >
                  {showPreview ? <Pencil size={14} /> : <Eye size={14} />}
                </button>
              )}
              {isText && (
                <button type="button" className={`fx-icon-btn${wrap ? " on" : ""}`} title="Toggle word wrap (Alt+Z)" aria-pressed={wrap} onClick={onToggleWrap}>
                  <WrapText size={14} />
                </button>
              )}
              {isText && !buffer?.readOnly && (
                <button
                  type="button"
                  className="fx-icon-btn"
                  title="Save (Ctrl+S)"
                  disabled={!dirty.has(active)}
                  onClick={() => onSave(active)}
                >
                  <Save size={14} />
                </button>
              )}
            </div>
          </div>
          {buffer?.conflict && (
            <div className="fx-banner warn" role="alert">
              <AlertTriangle size={14} />
              <span>This file changed on disk while you had unsaved edits.</span>
              <button type="button" className="fx-banner-btn" onClick={() => onResolveConflict(active, "reload")}>
                Reload from disk
              </button>
              <button type="button" className="fx-banner-btn" onClick={() => onResolveConflict(active, "keepMine")}>
                Keep my edits
              </button>
            </div>
          )}
          {buffer?.missing && (
            <div className="fx-banner danger" role="alert">
              <FileWarning size={14} />
              <span>This file no longer exists on disk.</span>
              {!dirty.has(active) && (
                <button type="button" className="fx-banner-btn" onClick={() => onClose(active)}>
                  Close
                </button>
              )}
            </div>
          )}
          <div className="fx-editor-area">
            {!view || view.status === "loading" ? (
              <div className="fx-placeholder">Loading…</div>
            ) : view.status === "error" ? (
              <div className="fx-placeholder">
                {view.message}
                <button type="button" className="fx-link-btn" onClick={() => onRetry(active)}>
                  Retry
                </button>
              </div>
            ) : view.status === "binary" ? (
              <div className="fx-placeholder">
                <strong>{baseName(active)}</strong>
                <span>Binary file ({formatBytes(view.size)}) — not shown in the editor.</span>
              </div>
            ) : view.status === "tooLarge" ? (
              <div className="fx-placeholder">
                <strong>{baseName(active)}</strong>
                <span>This file is too large to open ({formatBytes(view.size)}).</span>
              </div>
            ) : view.status === "image" ? (
              <ImageView sessionId={sessionId} path={active} />
            ) : !buffer || !activeKey ? (
              <div className="fx-placeholder">Loading…</div>
            ) : showPreview ? (
              <div className="fx-md-preview">
                <Md text={buffer.content} />
              </div>
            ) : (
              <CodeEditor
                bufferKey={activeKey}
                path={active}
                readOnly={buffer.readOnly === true}
                wrap={wrap}
                reveal={reveal && reveal.path === active ? reveal : null}
                baseline={baselines[active] ?? null}
                onSave={() => onSave(active)}
                onStatus={setStatus}
              />
            )}
          </div>
          <div className="fx-status" aria-label="Editor status">
            {isText && status && !showPreview ? (
              <>
                <span>
                  Ln {status.line}, Col {status.column}
                  {status.selected > 0 ? ` (${status.selected} selected)` : ""}
                  {status.cursors > 1 ? ` · ${status.cursors} cursors` : ""}
                </span>
                <span className="fx-status-spacer" />
                <span>{status.indentLabel}</span>
                <span>{view?.status === "text" && view.readOnlyReason === "encoding" ? "Non-UTF-8" : "UTF-8"}</span>
                <span>{status.eol}</span>
                <span>{status.language}</span>
              </>
            ) : (
              <>
                <span className="fx-status-spacer" />
                <span>{language}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="fx-welcome">
          <div className="fx-welcome-title">No file open</div>
          <dl className="fx-welcome-keys">
            <dt>Go to file</dt>
            <dd>
              <kbd>Ctrl</kbd> <kbd>P</kbd>
            </dd>
            <dt>Search in files</dt>
            <dd>
              <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd>
            </dd>
            <dt>Find in file</dt>
            <dd>
              <kbd>Ctrl</kbd> <kbd>F</kbd>
            </dd>
            <dt>Go to line</dt>
            <dd>
              <kbd>Ctrl</kbd> <kbd>G</kbd>
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
