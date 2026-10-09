import type { RefObject } from "react";
import { BookmarkPlus, ChevronDown, RefreshCw, RotateCcw, Search } from "lucide-react";
import type { GitHubKind } from "../cw.js";
import type { GitHubView } from "../stores/githubStore.js";
import { GitHubAvatar } from "./GitHubAvatar.js";
import { GitHubQueryEditor } from "./GitHubQueryEditor.js";
import { KIND_ICONS, NamedIcon } from "./GitHubIcon.js";
import type { SuggestionSource } from "./githubQuery.js";
import { KIND_LABELS, KIND_ORDER, type TabBadge } from "./githubViewModel.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { useNow } from "./usageFormat.js";

const BADGE_CAP = 99;

export interface HubAccount {
  host: string;
  login: string;
}

function TabButton({ kind, active, badge, onSelect }: { kind: GitHubKind; active: boolean; badge: TabBadge; onSelect: () => void }) {
  const Icon = KIND_ICONS[kind];
  const toneClass = badge.tone === "default" ? "" : ` ${badge.tone}`;
  return (
    <button type="button" className={`hub-tab${active ? " active" : ""}`} role="tab" aria-selected={active} onClick={onSelect}>
      <Icon size={14} aria-hidden="true" />
      <span className="hub-tab-label">{KIND_LABELS[kind]}</span>
      {badge.count > 0 && <span className={`hub-tab-count${toneClass}`}>{badge.count > BADGE_CAP ? `${BADGE_CAP}+` : badge.count}</span>}
    </button>
  );
}

function RefreshButton({ fetchedAt, loading, onRefresh }: { fetchedAt: number | null; loading: boolean; onRefresh: () => void }) {
  const now = useNow();
  const synced = fetchedAt !== null ? `synced ${formatRelativeAge(fetchedAt, now)} ago via gh` : "not synced yet";
  return (
    <button
      type="button"
      className="icon-btn hub-refresh"
      onClick={onRefresh}
      disabled={loading}
      title={`Refresh · ${synced}`}
      aria-label={`Refresh, ${synced}`}
    >
      <RefreshCw size={15} aria-hidden="true" className={loading ? "pr-inbox-spin" : undefined} />
    </button>
  );
}

export function GitHubHeader({
  kind,
  query,
  view,
  edited,
  badges,
  source,
  account,
  fetchedAt,
  loading,
  inputRef,
  viewButtonRef,
  viewsOpen,
  onSelectKind,
  onQueryChange,
  onOpenViews,
  onReset,
  onRefresh
}: {
  kind: GitHubKind;
  query: string;
  view: GitHubView | null;
  edited: boolean;
  badges: Record<GitHubKind, TabBadge>;
  source: SuggestionSource;
  account: HubAccount | null;
  fetchedAt: number | null;
  loading: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  viewButtonRef: RefObject<HTMLButtonElement | null>;
  viewsOpen: boolean;
  onSelectKind: (kind: GitHubKind) => void;
  onQueryChange: (query: string) => void;
  onOpenViews: (saving: boolean) => void;
  onReset: () => void;
  onRefresh: () => void;
}) {
  return (
    <div
      className="head-seg main-seg hub-head"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest(".hub-search, .hub-tabs, button")) return;
        void window.cw.toggleMaximizeWindow();
      }}
    >
      <div className="head-col col-left">
        <div className="hub-tabs" role="tablist" aria-label="GitHub">
          {KIND_ORDER.map((id) => (
            <TabButton key={id} kind={id} active={kind === id} badge={badges[id]} onSelect={() => onSelectKind(id)} />
          ))}
        </div>
      </div>
      <div className="head-col col-mid">
        <div className="hub-search">
          <button
            ref={viewButtonRef}
            type="button"
            className={`hub-view-btn${viewsOpen ? " open" : ""}`}
            title="Views"
            aria-haspopup="dialog"
            aria-expanded={viewsOpen}
            onClick={() => onOpenViews(false)}
          >
            <NamedIcon name={view?.icon ?? "Bookmark"} size={13} />
            <span className="name">{view?.name ?? "Custom query"}</span>
            {edited && view && <span className="hub-view-mod">edited</span>}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <span className="hub-search-ic">
            <Search size={14} aria-hidden="true" />
          </span>
          <GitHubQueryEditor kind={kind} query={query} source={source} inputRef={inputRef} onChange={onQueryChange} />
          <span className="hub-search-end">
            {edited ? (
              <>
                <button type="button" className="hub-mini-btn accent" title="Save this query as a view" onClick={() => onOpenViews(true)}>
                  <BookmarkPlus size={12} aria-hidden="true" />
                  Save
                </button>
                {view && (
                  <button
                    type="button"
                    className="hub-mini-btn"
                    title={`Reset to “${view.name}”`}
                    aria-label={`Reset to ${view.name}`}
                    onClick={onReset}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                  </button>
                )}
              </>
            ) : (
              <span className="side-kbd">/</span>
            )}
          </span>
        </div>
      </div>
      <div className="head-col col-right">
        {account && (
          <span className="hub-account" title={`Signed in to ${account.host} via gh as @${account.login}`}>
            <GitHubAvatar login={account.login} small />
          </span>
        )}
        <RefreshButton fetchedAt={fetchedAt} loading={loading} onRefresh={onRefresh} />
      </div>
    </div>
  );
}
