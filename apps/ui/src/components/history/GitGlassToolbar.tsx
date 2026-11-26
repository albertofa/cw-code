import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, PanelLeft, Search, SlidersHorizontal, UserRound, X } from "lucide-react";
import { MenuSelect } from "../MenuSelect.js";
import { HISTORY_SEARCH_SCOPES, type HistorySearchScope } from "./historySearch.js";

export interface ToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  title: string;
  disabled?: boolean;
  badge?: number | null;
  badgeHint?: string;
  onClick?: () => void;
}

export interface ToolbarSearch {
  text: string;
  scope: HistorySearchScope;
  counter: string | null;
  onText: (text: string) => void;
  onScope: (scope: HistorySearchScope) => void;
  onNext: () => void;
  onPrevious: () => void;
}

export interface ToolbarViewOptions {
  absoluteDates: boolean;
  showAuthors: boolean;
  onAbsoluteDates: (value: boolean) => void;
  onShowAuthors: (value: boolean) => void;
}

function ActionButton({ action }: { action: ToolbarAction }) {
  return (
    <button
      type="button"
      className="gg-act"
      aria-disabled={action.disabled || undefined}
      title={action.title}
      aria-label={action.badge ? `${action.label}, ${action.badge}${action.badgeHint ? ` ${action.badgeHint}` : ""}` : action.label}
      onClick={action.disabled ? undefined : action.onClick}
    >
      {action.badge ? <span className="gg-act-badge">{action.badge}</span> : null}
      {action.icon}
      <span className="gg-act-label">{action.label}</span>
    </button>
  );
}

function SearchBox({ search, floating, onDone }: { search: ToolbarSearch; floating: boolean; onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeLabel = HISTORY_SEARCH_SCOPES.find((option) => option.id === search.scope)?.label ?? "Everything";
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) search.onPrevious();
      else search.onNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (search.text) search.onText("");
      else {
        inputRef.current?.blur();
        onDone();
      }
    }
  };
  return (
    <div className={`gg-search${floating ? " floating" : ""}`} role="search">
      <MenuSelect
        label="Search in"
        title="Choose what the search looks at"
        direction="down"
        value={search.scope}
        display={scopeLabel}
        icon={<Search size={12} aria-hidden="true" />}
        options={HISTORY_SEARCH_SCOPES.map((option) => ({ id: option.id, label: option.label }))}
        onPick={(id) => search.onScope(id as HistorySearchScope)}
      />
      <input
        ref={inputRef}
        className="gg-search-input"
        value={search.text}
        autoFocus={floating}
        placeholder="Search, or author:, sha:…"
        aria-label="Search the loaded history"
        onChange={(event) => search.onText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {search.counter !== null && (
        <>
          <span className="gg-search-count">{search.counter}</span>
          <button type="button" className="gg-icon-btn sm" onClick={search.onPrevious} title="Previous match (Shift+Enter)" aria-label="Previous match">
            <ChevronUp size={13} aria-hidden="true" />
          </button>
          <button type="button" className="gg-icon-btn sm" onClick={search.onNext} title="Next match (Enter)" aria-label="Next match">
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </>
      )}
      {(search.text || floating) && (
        <button
          type="button"
          className="gg-icon-btn sm"
          onClick={() => {
            search.onText("");
            onDone();
          }}
          title="Clear the search (Esc)"
          aria-label="Clear the search"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ViewOptionsMenu({ options }: { options: ToolbarViewOptions }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("[role='menuitemcheckbox']")?.focus();
  }, [open]);
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const rows = [
    { id: "dates", label: "Show exact dates", checked: options.absoluteDates, toggle: () => options.onAbsoluteDates(!options.absoluteDates) },
    { id: "authors", label: "Show author names", checked: options.showAuthors, toggle: () => options.onShowAuthors(!options.showAuthors) }
  ];
  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className={`gg-icon-btn${open ? " on" : ""}`}
        title="View options"
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            className="menu-panel menu-panel-down gg-menu-end"
            role="menu"
            aria-label="View options"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            {rows.map((row) => (
              <div
                key={row.id}
                className="menu-row"
                role="menuitemcheckbox"
                aria-checked={row.checked}
                tabIndex={0}
                onClick={row.toggle}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    row.toggle();
                  }
                }}
              >
                <span className="menu-text">
                  <span className="name">{row.label}</span>
                </span>
                <span className="menu-check" aria-hidden>
                  {row.checked ? <Check size={14} aria-hidden="true" /> : null}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function GitGlassToolbar({
  narrow,
  sidebarOpen,
  onToggleSidebar,
  repoName,
  branchPicker,
  groups,
  search,
  showAvatars,
  onToggleAvatars,
  viewOptions
}: {
  narrow: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  repoName: string | null;
  branchPicker: ReactNode;
  groups: ToolbarAction[][];
  search: ToolbarSearch;
  showAvatars: boolean;
  onToggleAvatars: () => void;
  viewOptions: ToolbarViewOptions;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const visibleGroups = groups.filter((group) => group.length > 0);
  return (
    <div className="gg-toolbar">
      <div className="gg-tb-left">
        <button
          type="button"
          className={`gg-icon-btn${sidebarOpen ? " on" : ""}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
          aria-label="Toggle the sidebar"
          aria-pressed={sidebarOpen}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <div className="gg-repo">
          {repoName && <span className="gg-repo-name">{repoName}</span>}
          {branchPicker}
        </div>
      </div>
      <div className="gg-tb-actions" role="toolbar" aria-label="Git actions">
        {visibleGroups.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 && <span className="gg-act-sep" aria-hidden="true" />}
            {group.map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="gg-tb-right">
        {narrow ? (
          <>
            <button
              type="button"
              className={`gg-icon-btn${search.text ? " on" : ""}`}
              onClick={() => setSearchOpen(true)}
              title="Search the loaded history"
              aria-label="Search the loaded history"
            >
              <Search size={15} aria-hidden="true" />
            </button>
            {searchOpen && <SearchBox search={search} floating onDone={() => setSearchOpen(false)} />}
          </>
        ) : (
          <SearchBox search={search} floating={false} onDone={() => undefined} />
        )}
        <button
          type="button"
          className={`gg-icon-btn${showAvatars ? " on" : ""}`}
          aria-pressed={showAvatars}
          title="Show author photos from GitHub on commits"
          aria-label="Author photos"
          onClick={onToggleAvatars}
        >
          <UserRound size={15} aria-hidden="true" />
        </button>
        <ViewOptionsMenu options={viewOptions} />
      </div>
    </div>
  );
}
