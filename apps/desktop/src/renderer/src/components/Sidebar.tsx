import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Bell, ChartColumn, Check, ChevronDown, ChevronRight, ChevronUp, CircleHelp, Clock, GitBranch, GitPullRequest, Hash, LoaderCircle, Plus, Search, Settings, ShieldAlert, X, type LucideIcon } from "lucide-react";
import type { DriverName, PrSummary, Session, SessionStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { UpdateIndicator } from "./UpdateIndicator.js";
import { useNotifs } from "./Notifications.js";
import { getLastModel } from "./lastModel.js";
import { projectAvatarStyle as avatarStyle, projectInitials as initials } from "./avatar.js";
import { mergeAwayIds } from "./sidebarOrder.js";
import { compareWorkingSet, isWorkingSetStatus } from "./workingSet.js";
import { shortenHome } from "./pathDisplay.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { needsAttentionCount } from "./prInbox.js";
import { anyLinkUnseen, displayChip, linksTitle, mostUrgentLink, sessionLinks } from "./sessionPrLinks.js";
import { matchesQuickFilter, matchesSessionQuery, quickFilterCounts, toggleQuickFilter, type QuickFilter } from "./sidebarQuickFilters.js";
import { compareNeedsYou, type Attention, type AttentionKind } from "./needsYou.js";
import { useNeedsYou } from "./useNeedsYou.js";
import appIcon from "../assets/console-c.svg";

const IDLE_LIMIT = 4;
const FLIP_MS_FALLBACK = 150;
const FLIP_EASING_FALLBACK = "cubic-bezier(0.22, 1, 0.36, 1)";
const ORDER_KEY = "cw:order:all";

const ATTENTION_ACTION: Record<AttentionKind, { verb: string; Icon: LucideIcon }> = {
  approval: { verb: "Approve", Icon: ShieldAlert },
  question: { verb: "Answer", Icon: CircleHelp },
  update: { verb: "Review", Icon: Bell }
};

function rootToken(name: string): string {
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function flipEasing(): string {
  return rootToken("--ease-out") || FLIP_EASING_FALLBACK;
}

function flipDuration(): number {
  const raw = rootToken("--dur-fast");
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return FLIP_MS_FALLBACK;
  if (raw.endsWith("ms")) return value;
  return raw.endsWith("s") ? value * 1000 : FLIP_MS_FALLBACK;
}

function stateLabel(status: SessionStatus): string {
  if (status === "input-required") return "Input";
  if (status === "working") return "Running";
  if (status === "done") return "Done";
  if (status === "holding") return "Holding";
  return status;
}

function ageLabel(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function fullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const DRIVER_LABEL: Record<DriverName, string> = {
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex"
};

function sessionHasUnseen(session: Session, summaryByKey: Map<string, PrSummary>): boolean {
  return anyLinkUnseen(sessionLinks(session), summaryByKey);
}

const QUICK_FILTER_UI: Array<{ id: Exclude<QuickFilter, "all">; label: string; hint: string; Icon: LucideIcon }> = [
  { id: "running", label: "Running", hint: "Running", Icon: LoaderCircle },
  { id: "pr", label: "Linked to a PR", hint: "Linked to a PR", Icon: GitPullRequest },
  { id: "updated", label: "PR updated", hint: "PR updates, across all sections", Icon: Bell }
];

const HOVER_DELAY = 350;
const HOVER_FALLBACK_HEIGHT = 280;

type SidebarSection = "main" | "resolved";

interface SidebarOrder {
  main: string[];
  resolved: string[];
  pinned: string[];
}

interface SlotRow {
  id: string;
  section: SidebarSection;
  top: number;
  height: number;
}

interface SlotSnapshot {
  rows: SlotRow[];
  scrollTop: number;
  ids: string;
}

function layoutTop(el: HTMLElement): { top: number; height: number } {
  const rect = el.getBoundingClientRect();
  let shift = 0;
  try {
    shift = new DOMMatrixReadOnly(window.getComputedStyle(el).transform).m42;
  } catch {
    shift = 0;
  }
  return { top: rect.top - shift, height: rect.height };
}

function contentTop(el: HTMLElement, list: HTMLElement): { top: number; height: number } {
  const { top, height } = layoutTop(el);
  return { top: top - list.getBoundingClientRect().top + list.scrollTop, height };
}

function slotInRows(
  rows: SlotRow[],
  y: number,
  fromId: string,
  fallback: SidebarSection
): { targetId: string | null; section: SidebarSection; before: boolean } {
  for (const r of rows) {
    if (r.id === fromId) continue;
    if (y < r.top + r.height / 2) return { targetId: r.id, section: r.section, before: true };
    if (y < r.top + r.height) return { targetId: r.id, section: r.section, before: false };
  }
  const last = [...rows].reverse().find((r) => r.id !== fromId);
  return { targetId: null, section: last?.section ?? fallback, before: false };
}

function previewPlacement(
  orderedMain: Session[],
  orderedResolved: Session[],
  dragged: { id: string; section: SidebarSection } | null,
  preview: { targetId: string | null; section: SidebarSection; before: boolean } | null,
  section: SidebarSection
): Session[] {
  if (!dragged || !preview) return section === "main" ? orderedMain : orderedResolved;
  const moving = [...orderedMain, ...orderedResolved].find((s) => s.id === dragged.id);
  if (!moving) return section === "main" ? orderedMain : orderedResolved;
  const base = (section === "main" ? orderedMain : orderedResolved).filter((s) => s.id !== dragged.id);
  if (preview.section !== section) return base;
  const idx = base.findIndex((s) => s.id === preview.targetId);
  if (idx === -1) return [...base, moving];
  base.splice(preview.before ? idx : idx + 1, 0, moving);
  return base;
}

function readStoredOrder(key: string): SidebarOrder | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SidebarOrder>;
    if (!Array.isArray(parsed.main) || !Array.isArray(parsed.resolved)) return null;
    const pinned = Array.isArray(parsed.pinned) ? parsed.pinned.filter((id): id is string => typeof id === "string") : [];
    return {
      main: parsed.main.filter((id): id is string => typeof id === "string"),
      resolved: parsed.resolved.filter((id): id is string => typeof id === "string"),
      pinned,
    };
  } catch {
    return null;
  }
}

function writeStoredOrder(key: string, order: SidebarOrder): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(order));
  } catch {
    return;
  }
}

function orderByStored(current: Session[], ids: string[]): Session[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  const known = current
    .filter((s) => index.has(s.id))
    .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  const unknown = current.filter((s) => !index.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...known, ...unknown];
}

function DebugMenu() {
  const [open, setOpen] = useState(false);
  if (!window.cw.isDev) return null;

  const openTrace = async (): Promise<void> => {
    setOpen(false);
    try {
      const res = await window.cw.openHarnessTrace();
      if (!res.ok) {
        useNotifs.getState().push({
          kind: "error",
          title: "Could not open trace",
          message: res.error ?? res.path ?? "unknown error"
        });
      }
    } catch (err) {
      useNotifs.getState().push({
        kind: "error",
        title: "Could not open trace",
        message: (err as Error).message
      });
    }
  };

  return (
    <div className="menu titlebar-menu">
      <button
        className="menu-btn"
        aria-label="Debug"
        title="Debug"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="menu-value">Debug</span>
        <span className="menu-chevron">{open ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-panel" role="menu" aria-label="Debug">
            <div
              className="menu-row"
              role="menuitem"
              title="Open harness-trace.jsonl"
              onClick={() => void openTrace()}
            >
              <span className="menu-text">
                <span className="name">Open trace</span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


export function Sidebar({ onOpenSkills, skillsOpen = false, hidden = false }: { onOpenSkills: () => void; skillsOpen?: boolean; hidden?: boolean }) {
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const projects = useAppStore((s) => s.projects);
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const gitStatusBySession = useAppStore((s) => s.gitStatusBySession);
  const homeDir = useAppStore((s) => s.homeDir);
  const pendingDriver = useAppStore((s) => s.pendingDriver);
  const selectStoreSession = useAppStore((s) => s.selectSession);
  const startNewSession = useAppStore((s) => s.startNewSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const regenerateSessionTitle = useAppStore((s) => s.regenerateSessionTitle);
  const setSessionStatus = useAppStore((s) => s.setSessionStatus);
  const shortPath = (value: string): string => shortenHome(value, homeDir ?? undefined);
  const inbox = usePrStore((s) => s.inbox);
  const { attentionOf, summaryByKey } = useNeedsYou();
  const mainView = usePrStore((s) => s.mainView);
  const openInbox = usePrStore((s) => s.openInbox);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const openUsage = usePrStore((s) => s.openUsage);
  const openSettings = usePrStore((s) => s.openSettings);
  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dragged, setDragged] = useState<{ id: string; section: SidebarSection; title: string } | null>(null);
  const [preview, setPreview] = useState<{ targetId: string | null; section: SidebarSection; before: boolean } | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [idleShowAll, setIdleShowAll] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [storedOrder, setStoredOrder] = useState<SidebarOrder | null>(() => readStoredOrder(ORDER_KEY));
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const hoverModel = useAppStore((s) => (hover ? s.composerBySession[hover.id]?.model : undefined));
  const dragRef = useRef<{ id: string; section: SidebarSection; title: string; startX: number; startY: number; active: boolean } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const scrollTimer = useRef<number | null>(null);
  const pointerY = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resolvedToggleRef = useRef<HTMLButtonElement>(null);
  const slotSnap = useRef<SlotSnapshot | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, { top: number; height: number }>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const next = new Map<string, { top: number; height: number }>();
    rowRefs.current.forEach((el, id) => {
      if (!el.isConnected) {
        rowRefs.current.delete(id);
        return;
      }
      next.set(id, contentTop(el, list));
    });
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      let easing: string | null = null;
      let duration: number | null = null;
      prevRects.current.forEach((prev, id) => {
        const el = rowRefs.current.get(id);
        const cur = next.get(id);
        if (!el || !cur || prev.height === 0 || cur.height === 0) return;
        const dy = prev.top - cur.top;
        if (dy === 0) return;
        easing ??= flipEasing();
        duration ??= flipDuration();
        el.getAnimations().forEach((a) => a.cancel());
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }], { duration, easing });
      });
    }
    prevRects.current = next;
  });
  useEffect(() => {
    document.body.classList.toggle("session-dragging", dragged !== null);
    return () => document.body.classList.remove("session-dragging");
  }, [dragged]);

  useEffect(() => () => {
    detachRef.current?.();
    stopAutoScroll();
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  }, []);

  const clearHover = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHover(null);
  };

  const scheduleHover = (id: string) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const el = rowRefs.current.get(id);
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      setHover({
        id,
        x: Math.min(r.right + 10, window.innerWidth - 310),
        y: Math.max(8, Math.min(r.top - 6, window.innerHeight - HOVER_FALLBACK_HEIGHT))
      });
    }, HOVER_DELAY);
  };

  useEffect(() => {
    if (dragged || menu) clearHover();
  }, [dragged, menu]);

  useEffect(() => {
    const focusSearch = () => {
      if (!hiddenRef.current) searchRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (hiddenRef.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("cw:focus-search", focusSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cw:focus-search", focusSearch);
    };
  }, []);

  const trimmedQuery = query.trim();
  const projectNameById = useMemo<Record<string, string>>(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  const source = useMemo<Session[]>(() => Object.values(sessionsByProject).flat(), [sessionsByProject]);
  const inboxItems = inbox?.items;
  const branchOf = useCallback((s: Session): string | undefined => gitStatusBySession[s.id]?.branch ?? s.branch, [gitStatusBySession]);
  const needsYouAll = useMemo(
    () =>
      source
        .flatMap((session) => {
          const attention = attentionOf(session);
          return attention ? [{ session, attention, updatedAt: session.updatedAt }] : [];
        })
        .sort(compareNeedsYou),
    [source, attentionOf]
  );
  const attentionIds = useMemo(() => new Set(needsYouAll.map((entry) => entry.session.id)), [needsYouAll]);
  const prUpdatedIds = useMemo(
    () => new Set(needsYouAll.filter((entry) => entry.attention.kind === "update").map((entry) => entry.session.id)),
    [needsYouAll]
  );
  const quickFacts = useCallback(
    (s: Session) => ({ status: s.status, linkCount: sessionLinks(s).length, prUpdated: prUpdatedIds.has(s.id) }),
    [prUpdatedIds]
  );
  const quickCounts = useMemo(() => quickFilterCounts(source.map(quickFacts)), [source, quickFacts]);
  const matchesQuery = useCallback(
    (s: Session) =>
      matchesSessionQuery(trimmedQuery, { title: s.title, project: projectNameById[s.projectId] ?? "", branch: branchOf(s) }) &&
      matchesQuickFilter(quickFilter, quickFacts(s)),
    [trimmedQuery, projectNameById, branchOf, quickFilter, quickFacts]
  );
  const needsYouShown = useMemo(() => needsYouAll.filter((entry) => matchesQuery(entry.session)), [needsYouAll, matchesQuery]);
  const workingSetAll = useMemo(
    () => source.filter((s) => isWorkingSetStatus(s.status) && !attentionIds.has(s.id)).sort(compareWorkingSet),
    [source, attentionIds]
  );
  const workingSetShown = useMemo(() => workingSetAll.filter(matchesQuery), [workingSetAll, matchesQuery]);
  const awayIds = useMemo(() => new Set([...attentionIds, ...workingSetAll.map((s) => s.id)]), [attentionIds, workingSetAll]);
  const { orderedMainAll, orderedResolvedAll } = useMemo(() => {
    const storedMain = (storedOrder?.main ?? []).filter((id) => !awayIds.has(id));
    const storedResolved = (storedOrder?.resolved ?? []).filter((id) => !awayIds.has(id));
    const pinnedSet = new Set((storedOrder?.pinned ?? []).filter((id) => !awayIds.has(id)));
    const storedMainSet = new Set(storedMain);
    const storedResolvedSet = new Set(storedResolved);
    const effectiveSection = (s: Session): SidebarSection | null => {
      if (s.status === "archived") return null;
      if (pinnedSet.has(s.id)) {
        const inMain = storedMainSet.has(s.id);
        const inResolved = storedResolvedSet.has(s.id);
        if (inMain !== inResolved) return inMain ? "main" : "resolved";
      }
      if (s.status === "resolved") return "resolved";
      return "main";
    };
    const byRecency = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
    const mainAll = source.filter((s) => !awayIds.has(s.id) && effectiveSection(s) === "main");
    const resolvedAll = source.filter((s) => !awayIds.has(s.id) && effectiveSection(s) === "resolved");
    return {
      orderedMainAll: [...mainAll].sort(byRecency),
      orderedResolvedAll: storedOrder ? orderByStored(resolvedAll, storedResolved) : [...resolvedAll].sort(byRecency)
    };
  }, [source, awayIds, storedOrder]);
  const previewing = dragged !== null && preview !== null;
  const idleFiltered = useMemo(
    () => (previewing ? previewPlacement(orderedMainAll, orderedResolvedAll, dragged, preview, "main") : orderedMainAll).filter(matchesQuery),
    [previewing, orderedMainAll, orderedResolvedAll, dragged, preview, matchesQuery]
  );
  const resolvedShown = useMemo(
    () => (previewing ? previewPlacement(orderedMainAll, orderedResolvedAll, dragged, preview, "resolved") : orderedResolvedAll).filter(matchesQuery),
    [previewing, orderedMainAll, orderedResolvedAll, dragged, preview, matchesQuery]
  );
  const idleUnlimited = trimmedQuery !== "" || idleShowAll;
  const draggedId = dragged?.id;
  const idleShown = useMemo(() => {
    const head = idleUnlimited ? idleFiltered : idleFiltered.slice(0, IDLE_LIMIT);
    const draggedIdle = draggedId ? idleFiltered.find((s) => s.id === draggedId) : undefined;
    return draggedIdle && !head.includes(draggedIdle) ? [...head, draggedIdle] : head;
  }, [idleFiltered, idleUnlimited, draggedId]);
  const idleToggleVisible = trimmedQuery === "" && idleFiltered.length > IDLE_LIMIT;
  const resolvedExpanded = trimmedQuery !== "" || resolvedOpen;
  const workingSetVisible = source.length > 0 || quickFilter !== "all";
  const attentionCount = useMemo(() => needsAttentionCount(inboxItems ?? []), [inboxItems]);
  const anyUnseen = useMemo(() => source.some((s) => sessionHasUnseen(s, summaryByKey)), [source, summaryByKey]);
  const inboxActive = mainView.kind === "inbox" || mainView.kind === "pr";
  const usageActive = mainView.kind === "usage";
  const newSessionActive = !inboxActive && !usageActive && (pendingDriver !== null || !activeSessionId);
  const inboxNotes = [
    attentionCount > 0 ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} you` : null,
    anyUnseen ? "updates available" : null
  ].filter(Boolean);
  const inboxTitle = ["Pull requests", ...inboxNotes].join(" · ");
  const inboxLabel = ["Pull requests", ...inboxNotes].join(", ");
  const selectSession = (sessionId: string) => {
    openSessionView();
    selectStoreSession(sessionId);
  };
  const hoverSession = hover ? (source.find((s) => s.id === hover.id) ?? null) : null;
  const hoverStatus = hoverSession?.status ?? "idle";
  const hoverProject = hoverSession ? (projectNameById[hoverSession.projectId] ?? "") : "";
  const hoverBranch = hoverSession ? branchOf(hoverSession) : undefined;

  const captureSlots = (): void => {
    const rows: SlotRow[] = [];
    const put = (list: Session[], section: SidebarSection) => {
      for (const s of list) {
        const el = rowRefs.current.get(s.id);
        if (!el || !el.isConnected) continue;
        const { top, height } = layoutTop(el);
        if (height === 0) continue;
        rows.push({ id: s.id, section, top, height });
      }
    };
    put(orderedMainAll, "main");
    put(orderedResolvedAll, "resolved");
    slotSnap.current = {
      rows,
      scrollTop: listRef.current?.scrollTop ?? 0,
      ids: [...orderedMainAll, ...orderedResolvedAll].map((s) => s.id).join(",")
    };
  };

  const slotFromPoint = (clientY: number, onlySection?: SidebarSection): { targetId: string | null; section: SidebarSection; before: boolean } => {
    const snap = slotSnap.current;
    const from = dragRef.current;
    const fallback = from?.section ?? "main";
    if (!snap || !from) return { targetId: null, section: fallback, before: false };
    const y = clientY + ((listRef.current?.scrollTop ?? 0) - snap.scrollTop);
    const rows = onlySection ? snap.rows.filter((r) => r.section === onlySection) : snap.rows;
    return slotInRows(rows, y, from.id, onlySection ?? fallback);
  };

  const moveGhost = (x: number, y: number): void => {
    const el = ghostRef.current;
    if (el) el.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };

  const stopAutoScroll = (): void => {
    if (scrollTimer.current !== null) {
      window.clearInterval(scrollTimer.current);
      scrollTimer.current = null;
    }
  };

  const startAutoScroll = (): void => {
    stopAutoScroll();
    scrollTimer.current = window.setInterval(() => {
      const list = listRef.current;
      const d = dragRef.current;
      if (!list || !d?.active) return;
      const rect = list.getBoundingClientRect();
      if (pointerY.current < rect.top + 28) list.scrollTop -= 14;
      else if (pointerY.current > rect.bottom - 28) list.scrollTop += 14;
    }, 30);
  };

  const maybeOpenResolved = (clientX: number, clientY: number): void => {
    const el = resolvedToggleRef.current;
    if (!el?.isConnected) return;
    const r = el.getBoundingClientRect();
    if (clientX < r.left - 4 || clientX > r.right + 4 || clientY < r.top - 4 || clientY > r.bottom + 4) return;
    setResolvedOpen(true);
  };

  const copySessionId = (sessionId: string) => {
    setMenu(null);
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(sessionId).catch(() => {});
  };

  const commitRename = (sessionId: string) => {
    const draft = renameDraft.trim();
    setRenamingId(null);
    if (!draft) return;
    void renameSession(sessionId, draft).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not rename session", message: err.message });
    });
  };

  const regenerateTitle = (sessionId: string) => {
    setMenu(null);
    void regenerateSessionTitle(sessionId).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not regenerate title", message: err.message });
    });
  };

  const setStatus = (sessionId: string, status: SessionStatus) => {
    setMenu(null);
    void setSessionStatus(sessionId, status, "user-set-status").catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not update session", message: err.message });
    });
  };

  const handleDrop = (
    from: { id: string; section: SidebarSection },
    toSection: SidebarSection,
    targetId: string | null,
    before: boolean
  ) => {
    const fromId = from.id;
    const fromSection = from.section;
    setDragged(null);
    dragRef.current = null;
    slotSnap.current = null;
    setPreview(null);
    if (targetId === fromId && fromSection === toSection) return;
    const nextMain = orderedMainAll.filter((s) => s.id !== fromId);
    const nextResolved = orderedResolvedAll.filter((s) => s.id !== fromId);
    const moving = [...orderedMainAll, ...orderedResolvedAll].find((s) => s.id === fromId);
    if (!moving) {
      console.warn(`[sidebar] drop ignored: session ${fromId} not found`);
      return;
    }
    if (toSection === "main") {
      if (targetId) {
        const idx = nextMain.findIndex((s) => s.id === targetId);
        if (idx === -1) nextMain.push(moving);
        else nextMain.splice(before ? idx : idx + 1, 0, moving);
      } else {
        nextMain.push(moving);
      }
    } else {
      if (targetId) {
        const idx = nextResolved.findIndex((s) => s.id === targetId);
        if (idx === -1) nextResolved.push(moving);
        else nextResolved.splice(before ? idx : idx + 1, 0, moving);
      } else {
        nextResolved.push(moving);
      }
    }
    const nextMainIds = nextMain.map((s) => s.id);
    const nextResolvedIds = nextResolved.map((s) => s.id);
    const cross = fromSection !== toSection;
    const prevPinned = storedOrder?.pinned ?? [];
    const pinned = cross ? Array.from(new Set([...prevPinned, fromId])) : [];
    const nextOrder: SidebarOrder = {
      main: mergeAwayIds(storedOrder?.main ?? nextMainIds, nextMainIds, awayIds),
      resolved: mergeAwayIds(storedOrder?.resolved ?? nextResolvedIds, nextResolvedIds, awayIds),
      pinned
    };
    writeStoredOrder(ORDER_KEY, nextOrder);
    setStoredOrder(nextOrder);
    if (cross) setStatus(fromId, toSection === "main" ? "idle" : "resolved");
    setLandedId(fromId);
    window.setTimeout(() => setLandedId((id) => (id === fromId ? null : id)), 850);
  };

  const prBadge = (s: Session) => {
    const links = sessionLinks(s);
    const gitPr = gitStatusBySession[s.id]?.pullRequest ?? null;
    const urgent = mostUrgentLink(links, summaryByKey, gitPr);
    const chip = urgent ? displayChip(urgent, summaryByKey, gitPr) : null;
    const chipTitle = chip ? (links.length > 1 ? linksTitle(links, summaryByKey, gitPr) : chip.title) : null;
    return { links, chip, chipTitle };
  };

  const renderPrChip = (s: Session) => {
    const { links, chip, chipTitle } = prBadge(s);
    return chip ? <PrChipBadge chip={chip} extra={links.length - 1} title={chipTitle ?? undefined} /> : null;
  };

  const rowProps = (s: Session) => ({
    ref: (el: HTMLDivElement | null) => {
      if (el) rowRefs.current.set(s.id, el);
      else rowRefs.current.delete(s.id);
    },
    onMouseEnter: () => scheduleHover(s.id),
    onMouseLeave: clearHover,
    onClick: () => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      selectSession(s.id);
    },
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setRenamingId(null);
      setMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
    }
  });

  const renderRename = (s: Session) => (
    <input
      autoFocus
      className="session-rename"
      value={renameDraft}
      onChange={(e) => setRenameDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commitRename(s.id);
        if (e.key === "Escape") setRenamingId(null);
      }}
      onBlur={() => commitRename(s.id)}
    />
  );

  const renderTitle = (s: Session) => (renamingId === s.id ? renderRename(s) : <div className="ws-title">{s.title}</div>);

  const renderAttentionRow = (s: Session, attention: Attention) => {
    const projectName = projectNameById[s.projectId] ?? "";
    const { verb, Icon } = ATTENTION_ACTION[attention.kind];
    return (
      <div
        key={s.id}
        {...rowProps(s)}
        className={`ws-row attn attn-${attention.kind}${s.id === activeSessionId ? " on" : ""}`}
        aria-label={`${s.title}${projectName ? ` · ${projectName}` : ""}. ${verb}: ${attention.line}`}
      >
        <div className="ws-body">
          {renderTitle(s)}
          <div className="att-line">{attention.line}</div>
        </div>
        <div className="ws-side">
          <span className="att-chip">
            <Icon size={12} aria-hidden="true" />
            {verb}
          </span>
          <span className="ws-side-row">
            <span className="avatar sm" style={avatarStyle(projectName)} title={projectName}>{initials(projectName)}</span>
            <DriverIcon driver={s.driver} size={14} />
          </span>
        </div>
      </div>
    );
  };

  const renderWorkingState = (s: Session) => {
    if (s.status === "working") {
      return (
        <span className="ws-state status-working">
          <LoaderCircle size={12} className="ws-spin" aria-hidden="true" />
          Running
        </span>
      );
    }
    if (s.status === "holding") return <span className="ws-state status-holding">Holding · {ageLabel(s.updatedAt)}</span>;
    return <span className={`ws-state status-${s.status}`}>{stateLabel(s.status)}</span>;
  };

  const renderWorkingRow = (s: Session) => {
    const projectName = projectNameById[s.projectId] ?? "";
    const branch = branchOf(s);
    return (
      <div
        key={s.id}
        {...rowProps(s)}
        className={`ws-row${s.id === activeSessionId ? " on" : ""}`}
        aria-label={`${s.title}${projectName ? ` · ${projectName}` : ""}`}
      >
        <div className="ws-body">
          {renderTitle(s)}
          <div className="ws-meta">
            <span className="avatar sm" style={avatarStyle(projectName)}>{initials(projectName)}</span>
            <span className="ws-meta-text">{projectName}</span>
            {branch ? (
              <>
                <span className="ws-sep" aria-hidden="true">·</span>
                <GitBranch size={12} aria-hidden="true" />
                <span className="ws-branch">{branch}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="ws-side">
          {renderWorkingState(s)}
          <span className="ws-side-row">
            {renderPrChip(s)}
            <DriverIcon driver={s.driver} size={14} />
          </span>
        </div>
      </div>
    );
  };

  const renderFlatRow = (s: Session, section: SidebarSection) => {
    const git = gitStatusBySession[s.id];
    const { chipTitle } = prBadge(s);
    const projectName = projectNameById[s.projectId] ?? "";
    const gitSummary = [
      git?.branch ?? s.branch ? `Branch: ${git?.branch ?? s.branch}` : null,
      git?.worktreePath ?? s.worktreePath ? `Worktree: ${git?.worktreeName ?? shortPath(git?.worktreePath ?? s.worktreePath ?? "")}` : null,
      chipTitle,
      git && !git.clean ? `${git.dirtyCount} changed ${git.dirtyCount === 1 ? "file" : "files"}` : null
    ].filter((value): value is string => Boolean(value));
    const rowTitle = [s.title, projectName ? `Project: ${projectName}` : null, ...gitSummary].filter(Boolean).join("\n");
    const beginRowDrag = (e: ReactMouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("input,button")) return;
      if (renamingId === s.id || trimmedQuery) return;
      const pending = { id: s.id, section, title: s.title, startX: e.clientX, startY: e.clientY, active: false };
      dragRef.current = pending;
      const onMove = (ev: PointerEvent): void => {
        const d = dragRef.current;
        if (!d || d.id !== s.id) return;
        if (!d.active) {
          if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 6) return;
          d.active = true;
          captureSlots();
          setDragged({ id: d.id, section: d.section, title: d.title });
          startAutoScroll();
        }
        ev.preventDefault();
        pointerY.current = ev.clientY;
        moveGhost(ev.clientX, ev.clientY);
        maybeOpenResolved(ev.clientX, ev.clientY);
        const freshIds = Object.values(useAppStore.getState().sessionsByProject)
          .flat()
          .map((x) => x.id)
          .sort()
          .join(",");
        const snapIds = (slotSnap.current?.rows ?? []).map((r) => r.id).sort().join(",");
        if (!slotSnap.current || snapIds !== freshIds) captureSlots();
        const slot = slotFromPoint(ev.clientY);
        setPreview((prev) =>
          prev && prev.targetId === slot.targetId && prev.section === slot.section && prev.before === slot.before
            ? prev
            : slot
        );
      };
      const finish = (commit: boolean, ev?: PointerEvent): void => {
        detachRef.current?.();
        detachRef.current = null;
        stopAutoScroll();
        const d = dragRef.current;
        dragRef.current = null;
        slotSnap.current = null;
        setDragged(null);
        setPreview(null);
        if (!d?.active) return;
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 50);
        if (!commit || !ev) return;
        const active = { id: d.id, section: d.section };
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        if (!el || !(listRef.current?.contains(el) ?? false)) return;
        const toggle = el.closest(".session-resolved-toggle");
        if (el.closest(".resolved-empty-drop") || toggle) {
          if (toggle) setResolvedOpen(true);
          handleDrop(active, "resolved", null, false);
          return;
        }
        if (el.closest(".session-main-list")) {
          const slot = slotFromPoint(ev.clientY, "main");
          handleDrop(active, slot.section, slot.targetId, slot.before);
          return;
        }
        const slot = slotFromPoint(ev.clientY);
        handleDrop(active, slot.section, slot.targetId, slot.before);
      };
      const onUp = (ev: PointerEvent): void => finish(true, ev);
      const onCancel = (): void => finish(false);
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === "Escape") finish(false);
      };
      detachRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    };
    return (
      <div
        key={s.id}
        {...rowProps(s)}
        onMouseDown={beginRowDrag}
        className={`flat-row${section === "resolved" ? " resolved" : " idle"}${s.id === activeSessionId ? " on" : ""}${dragged?.id === s.id ? " dragging" : ""}${landedId === s.id ? " landed" : ""}`}
        aria-label={rowTitle}
      >
        {renamingId === s.id ? (
          renderRename(s)
        ) : (
          <span className="flat-title">
            {s.title}
            <span className="flat-project">{projectName}</span>
          </span>
        )}
        {renderPrChip(s)}
        <span className="flat-age">
          {section === "resolved" && <Check size={12} aria-hidden="true" />}
          {ageLabel(s.updatedAt)}
        </span>
        <DriverIcon driver={s.driver} size={14} />
      </div>
    );
  };

  return (
    <div
      className="side"
      hidden={hidden}
      style={hidden ? { display: "none" } : undefined}
      onClick={() => setMenu(null)}
    >
      <div className="head-seg side-seg" onDoubleClick={() => window.cw.toggleMaximizeWindow()}>
        <div className="titlebar-brand">
          <img className="titlebar-logo" src={appIcon} alt="" aria-hidden="true" draggable={false} />
          <span>cw-code</span>
        </div>
        <DebugMenu />
      </div>
      <div className="brand">
        <button
          type="button"
          className={`side-new-session${newSessionActive ? " active" : ""}`}
          onClick={() => {
            openSessionView();
            startNewSession();
          }}
          title="New session (Ctrl+T)"
        >
          <Plus size={15} aria-hidden="true" />
          <span>New session</span>
          <span className="side-kbd">Ctrl T</span>
        </button>
        <label className="side-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all sessions"
            aria-label="Search all sessions"
          />
          {query ? (
            <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              <X aria-hidden="true" size={14} />
            </button>
          ) : (
            <span className="side-kbd">Ctrl K</span>
          )}
        </label>
        <div className="side-nav">
          <button
            type="button"
            className={`side-nav-row${inboxActive ? " active" : ""}`}
            onClick={openInbox}
            title={inboxTitle}
            aria-label={inboxLabel}
            aria-pressed={inboxActive}
          >
            <GitPullRequest size={15} aria-hidden="true" />
            <span className="side-nav-label">Pull requests</span>
            <span className="side-nav-end">
              {anyUnseen && <span className="pr-unseen-dot" aria-hidden="true" />}
              {attentionCount > 0 && (
                <span className="side-nav-badge" aria-hidden="true">
                  {attentionCount > 99 ? "99+" : attentionCount}
                </span>
              )}
            </span>
          </button>
        </div>
      </div>
      <div className="session-list" ref={listRef} onScroll={clearHover}>
        <div className="session-main-list">
          {needsYouShown.length > 0 && (
            <div className="side-section">
              <div className="side-sec needs">
                Needs you
                <span className="side-needs-n">{needsYouShown.length}</span>
              </div>
              {needsYouShown.map((entry) => renderAttentionRow(entry.session, entry.attention))}
            </div>
          )}
          {workingSetVisible && (
            <div className="side-section">
              <div className="side-sec">
                Working set
                <span className="side-sec-n">{workingSetShown.length}</span>
                <span className="side-sec-end" role="group" aria-label="Quick filters">
                  <button
                    type="button"
                    className={`side-qf${quickFilter === "all" ? " on" : ""}`}
                    aria-pressed={quickFilter === "all"}
                    onClick={() => setQuickFilter("all")}
                  >
                    All
                  </button>
                  {QUICK_FILTER_UI.map(({ id, label, hint, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={`side-qf${quickFilter === id ? " on" : ""}${quickCounts[id] === 0 ? " is-zero" : ""}`}
                      onClick={() => setQuickFilter((current) => toggleQuickFilter(current, id))}
                      aria-pressed={quickFilter === id}
                      title={`${hint} (${quickCounts[id]})`}
                      aria-label={`${label}, ${quickCounts[id]}`}
                    >
                      <Icon size={12} aria-hidden="true" />
                      <span>{quickCounts[id]}</span>
                    </button>
                  ))}
                </span>
              </div>
              {workingSetShown.map((s) => renderWorkingRow(s))}
            </div>
          )}
          {idleShown.length > 0 && (
            <div className="side-section">
              <div className="side-sec">
                Idle
                <span className="side-sec-n">{idleFiltered.length}</span>
                {idleToggleVisible && (
                  <span className="side-sec-end">
                    <button type="button" className="side-qf" onClick={() => setIdleShowAll((v) => !v)} aria-pressed={idleShowAll}>
                      {idleShowAll ? "Show less" : "Show all"}
                    </button>
                  </span>
                )}
              </div>
              {idleShown.map((s) => renderFlatRow(s, "main"))}
            </div>
          )}
          {needsYouShown.length === 0 && workingSetShown.length === 0 && idleShown.length === 0 && resolvedShown.length === 0 && (
            <div className="side-empty">{trimmedQuery || quickFilter !== "all" ? "No matches." : "No sessions yet."}</div>
          )}
        </div>
        {resolvedShown.length > 0 && (
          <div className="side-section">
            {trimmedQuery ? (
              <div className="side-sec session-resolved-toggle is-static">
                Resolved
                <span className="side-sec-n">{resolvedShown.length}</span>
              </div>
            ) : (
              <button
                type="button"
                className="side-sec session-resolved-toggle"
                ref={resolvedToggleRef}
                onClick={() => setResolvedOpen((open) => !open)}
                aria-expanded={resolvedExpanded}
                aria-label={`${resolvedExpanded ? "Collapse" : "Expand"} resolved sessions`}
              >
                <ChevronRight size={12} className={`side-sec-chev${resolvedExpanded ? " open" : ""}`} aria-hidden="true" />
                Resolved
                <span className="side-sec-n">{resolvedShown.length}</span>
              </button>
            )}
            {resolvedExpanded && resolvedShown.map((s) => renderFlatRow(s, "resolved"))}
          </div>
        )}
        {resolvedShown.length === 0 && dragged && (
          <div
            className="resolved-empty-drop"
          >Drop here to resolve</div>
        )}
      </div>
      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 160), top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                const target = source.find((s) => s.id === menu.sessionId);
                setRenameDraft(target?.title ?? "");
                setRenamingId(menu.sessionId);
                setMenu(null);
              }}
            >
              Rename
            </button>
            <button className="ctx-item" onClick={() => regenerateTitle(menu.sessionId)}>
              Regenerate title
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "idle")}>
              Mark as Idle
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "done")}>
              Mark as Done
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "resolved")}>
              Mark as Resolved
            </button>
            <button className="ctx-item" onClick={() => setStatus(menu.sessionId, "archived")}>
              Archive
            </button>
            <button className="ctx-item" onClick={() => copySessionId(menu.sessionId)}>
              Copy session id
            </button>
          </div>
        </>
      )}
      <UpdateIndicator />
      <div className="side-footer">
        <button className="side-footer-btn" title="Settings" aria-label="Settings" onClick={() => openSettings()}>
          <Settings size={15} />
        </button>
        <button
          className={`side-footer-btn${usageActive ? " active" : ""}`}
          title="Usage"
          aria-label="Usage"
          aria-pressed={usageActive}
          onClick={openUsage}
        >
          <ChartColumn size={15} />
        </button>
        <button
          className={`side-footer-btn${skillsOpen ? " active" : ""}`}
          title="Skills"
          aria-label="Skills"
          aria-pressed={skillsOpen}
          onClick={onOpenSkills}
        >
          <span aria-hidden="true">✦</span>
          <span>Skills</span>
        </button>
      </div>
      {hover && hoverSession && (
        <div className="session-hovercard" style={{ left: hover.x, top: hover.y }} aria-hidden="true">
          <div className="session-hovercard-title">{hoverSession.title}</div>
          <div className="session-hovercard-row">
            <span className="avatar sm" style={avatarStyle(hoverProject)} aria-hidden="true">
              {initials(hoverProject)}
            </span>
            <span className="hovercard-text">{hoverProject}</span>
          </div>
          <div className="session-hovercard-row">
            <GitBranch size={13} aria-hidden="true" />
            <span className="hovercard-text">{hoverBranch ?? "No branch"}</span>
          </div>
          <div className="session-hovercard-row">
            <Hash size={13} aria-hidden="true" />
            <span className="hovercard-text hovercard-id">{hoverSession.id}</span>
          </div>
          <div className="session-hovercard-row">
            <DriverIcon driver={hoverSession.driver} size={16} />
            <span className="hovercard-text">
              {hoverModel ?? getLastModel(hoverSession.driver) ?? "No model"} · {DRIVER_LABEL[hoverSession.driver]}
            </span>
          </div>
          <div className="session-hovercard-row">
            {hoverStatus === "working" || hoverStatus === "input-required" ? (
              <span className={`session-dot status-${hoverStatus}`} aria-hidden="true" />
            ) : (
              <span className="session-dot" style={{ background: "var(--faint)" }} aria-hidden="true" />
            )}
            <span className="hovercard-text">{stateLabel(hoverStatus)}</span>
          </div>
          <div className="session-hovercard-row">
            <Clock size={13} aria-hidden="true" />
            <span className="hovercard-text">
              {ageLabel(hoverSession.updatedAt)} ago · {fullDate(hoverSession.updatedAt)}
            </span>
          </div>
        </div>
      )}
      {dragged && (
        <div ref={ghostRef} className="session-drag-ghost">
          <span className="session-title">{dragged.title}</span>
        </div>
      )}
    </div>
  );
}
