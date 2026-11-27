import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, PanelLeft, Search, SlidersHorizontal, UserRound, X } from "lucide-react";
import { MenuSelect } from "../MenuSelect.js";
import { HISTORY_SEARCH_SCOPES, type HistorySearchScope } from "./historySearch.js";

export interface ToolbarMenuItem {
  id: string;
  label: string;
  title: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  title: string;
  disabled?: boolean;
  badge?: number | null;
  badgeHint?: string;
  onClick?: () => void;
  menu?: ToolbarMenuItem[];
}

const MENU_GAP = 6;
const MENU_EDGE = 8;

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

function ActionMenu({ action, items }: { action: ToolbarAction; items: ToolbarMenuItem[] }) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const maxLeft = window.innerWidth - panel.offsetWidth - MENU_EDGE;
    if (anchor.left > maxLeft) setAnchor({ top: anchor.top, left: Math.max(MENU_EDGE, maxLeft) });
    panel.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setAnchor(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);

  const toggle = (): void => {
    if (open) {
      setAnchor(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + MENU_GAP, left: rect.left });
  };

  const close = (): void => {
    setAnchor(null);
    triggerRef.current?.focus();
  };

  const pick = (item: ToolbarMenuItem): void => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };

  const moveFocus = (step: 1 | -1): void => {
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    rows[(index + step + rows.length) % rows.length]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`gg-act gg-act-caret${open ? " on" : ""}`}
        title={`${action.label} options`}
        aria-label={`${action.label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <>
            <div className="menu-backdrop" onClick={() => setAnchor(null)} />
            <div
              ref={panelRef}
              className="menu-panel menu-panel-down gg-act-menu"
              role="menu"
              aria-label={`${action.label} options`}
              style={{ top: anchor.top, left: anchor.left }}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(event.key === "ArrowDown" ? 1 : -1);
                }
              }}
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  className="menu-row"
                  role="menuitem"
                  aria-disabled={item.disabled || undefined}
                  title={item.title}
                  tabIndex={-1}
                  onClick={() => pick(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      pick(item);
                    }
                  }}
                >
                  <span className="menu-text">
                    <span className="name">{item.label}</span>
                  </span>
                </div>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

function ToolbarButton({ action }: { action: ToolbarAction }) {
  if (!action.menu) return <ActionButton action={action} />;
  return (
    <span className="gg-act-split">
      <ActionButton action={action} />
      <ActionMenu action={action} items={action.menu} />
    </span>
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
              <ToolbarButton key={action.id} action={action} />
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
