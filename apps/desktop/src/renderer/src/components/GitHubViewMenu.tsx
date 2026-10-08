import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookmarkPlus, Pencil, Settings2, Trash2 } from "lucide-react";
import type { GitHubKind } from "../cw.js";
import { SAVED_VIEW_ICON, resolveViews, useGitHubStore, type GitHubView } from "../stores/githubStore.js";
import { AnchoredPopover, type AnchorRect } from "./AnchoredPopover.js";
import { KIND_ICONS, NamedIcon } from "./GitHubIcon.js";
import { KIND_LABELS, currentViewOf, isViewEdited } from "./githubViewModel.js";

const COUNTED_KINDS: GitHubKind[] = ["pr", "issue"];

function ViewIcon({ view, kind }: { view: GitHubView; kind: GitHubKind }) {
  if (view.kind === kind) return <NamedIcon name={view.icon} size={14} />;
  const Icon = KIND_ICONS[view.kind];
  return <Icon size={14} aria-hidden="true" />;
}

function ViewText({ view }: { view: GitHubView }) {
  return (
    <span className="t">
      <span className="n">{view.name}</span>
      <span className="qq">{view.query}</span>
    </span>
  );
}

export function GitHubViewMenu({ anchor, initialSaving, onClose }: { anchor: AnchorRect; initialSaving: boolean; onClose: () => void }) {
  const kind = useGitHubStore((s) => s.kind);
  const tab = useGitHubStore((s) => s.tabs[s.kind]);
  const org = useGitHubStore((s) => s.org);
  const savedViews = useGitHubStore((s) => s.savedViews);
  const viewCounts = useGitHubStore((s) => s.viewCounts);
  const selectView = useGitHubStore((s) => s.selectView);
  const saveView = useGitHubStore((s) => s.saveView);
  const renameView = useGitHubStore((s) => s.renameView);
  const deleteView = useGitHubStore((s) => s.deleteView);
  const loadViewCounts = useGitHubStore((s) => s.loadViewCounts);

  const [saving, setSaving] = useState(initialSaving);
  const [name, setName] = useState("");
  const [managing, setManaging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);

  const views = useMemo(() => resolveViews(kind, org, savedViews), [kind, org, savedViews]);
  const builtin = useMemo(() => views.filter((view) => !view.saved), [views]);
  const saved = useMemo(() => {
    const all = savedViews.map((view): GitHubView => ({ ...view, icon: SAVED_VIEW_ICON, saved: true }));
    return [...all.filter((view) => view.kind === kind), ...all.filter((view) => view.kind !== kind)];
  }, [savedViews, kind]);
  const canSave = isViewEdited(currentViewOf(views, tab.viewId), tab.query);

  const countedKinds = useMemo(
    () => COUNTED_KINDS.filter((candidate) => candidate === kind || savedViews.some((view) => view.kind === candidate)),
    [kind, savedViews]
  );
  useEffect(() => {
    for (const counted of countedKinds) void loadViewCounts(counted);
  }, [countedKinds, loadViewCounts]);

  const pick = (view: GitHubView) => {
    selectView(view.id);
    onClose();
  };

  const confirmSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void saveView(trimmed);
    onClose();
  };

  const startRename = (view: GitHubView) => {
    renamingRef.current = view.id;
    setRenamingId(view.id);
    setRenameValue(view.name);
    setConfirmingDeleteId(null);
  };

  const cancelRename = () => {
    renamingRef.current = null;
    setRenamingId(null);
  };

  const confirmRename = (id: string) => {
    if (renamingRef.current !== id) return;
    renamingRef.current = null;
    setRenamingId(null);
    const trimmed = renameValue.trim();
    if (trimmed) void renameView(id, trimmed);
  };

  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmRename(id);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      cancelRename();
    }
  };

  const countOf = (view: GitHubView) => {
    const count = viewCounts[view.id];
    return typeof count === "number" ? <span className="hub-count">{count}</span> : <span />;
  };

  const renderItem = (view: GitHubView) => {
    if (managing && view.saved) {
      return (
        <div key={view.id} className="hub-view-item manage">
          <ViewIcon view={view} kind={kind} />
          {renamingId === view.id ? (
            <input
              className="hub-rename-input"
              autoFocus
              value={renameValue}
              aria-label={`Rename ${view.name}`}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => onRenameKey(event, view.id)}
              onBlur={() => confirmRename(view.id)}
            />
          ) : (
            <ViewText view={view} />
          )}
          {confirmingDeleteId === view.id ? (
            <span className="hub-view-actions">
              <span className="hub-delete-ask">Delete?</span>
              <button
                type="button"
                className="hub-mini-btn danger"
                onClick={() => {
                  setConfirmingDeleteId(null);
                  void deleteView(view.id);
                }}
              >
                Yes
              </button>
              <button type="button" className="hub-mini-btn" onClick={() => setConfirmingDeleteId(null)}>
                No
              </button>
            </span>
          ) : (
            <span className="hub-view-actions">
              <button
                type="button"
                className="hub-mini-btn"
                title={`Rename ${view.name}`}
                aria-label={`Rename ${view.name}`}
                onClick={() => startRename(view)}
              >
                <Pencil size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="hub-mini-btn"
                title={`Delete ${view.name}`}
                aria-label={`Delete ${view.name}`}
                onClick={() => {
                  cancelRename();
                  setConfirmingDeleteId(view.id);
                }}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      );
    }
    const on = view.kind === kind && tab.viewId === view.id;
    return (
      <button
        key={view.id}
        type="button"
        className={`hub-view-item${on ? " on" : ""}`}
        title={view.kind === kind ? undefined : `Opens in ${KIND_LABELS[view.kind]}`}
        onClick={() => pick(view)}
      >
        <ViewIcon view={view} kind={kind} />
        <ViewText view={view} />
        {countOf(view)}
      </button>
    );
  };

  return (
    <AnchoredPopover anchor={anchor} label="Views" onClose={onClose} className="hub-views-pop">
      <div className="pr-inbox-popover-head">{KIND_LABELS[kind]} views</div>
      {builtin.map(renderItem)}
      <div className="pr-inbox-popover-sep" />
      <div className="pr-inbox-popover-head">
        Saved views
        <span className="hub-menu-head-right">all tabs</span>
      </div>
      {saved.length === 0 && <div className="pr-inbox-popover-empty">No saved views yet.</div>}
      {saved.map(renderItem)}
      <div className="pr-inbox-popover-sep" />
      {saving ? (
        <div className="hub-save-row">
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder="Name this view"
            aria-label="View name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmSave();
              }
            }}
          />
          <button type="button" className="hub-mini-btn accent" disabled={!name.trim()} onClick={confirmSave}>
            Save
          </button>
        </div>
      ) : (
        <button type="button" className="pr-inbox-popover-item" disabled={!canSave} onClick={() => setSaving(true)}>
          <BookmarkPlus size={13} aria-hidden="true" />
          <span>Save current query as a view</span>
        </button>
      )}
      <button
        type="button"
        className="pr-inbox-popover-item"
        aria-pressed={managing}
        onClick={() => {
          setManaging((value) => !value);
          cancelRename();
          setConfirmingDeleteId(null);
        }}
      >
        <Settings2 size={13} aria-hidden="true" />
        <span>{managing ? "Done managing" : "Manage views…"}</span>
      </button>
    </AnchoredPopover>
  );
}
