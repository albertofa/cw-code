import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, Clock, GitBranch, GitPullRequest, Hash, ListFilter, Plus, Search, Settings, X } from "lucide-react";
import type { DriverName, PrSummary, Project, Session, SessionStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { useNotifs } from "./Notifications.js";
import { getLastModel } from "./lastModel.js";
import { hashHue, projectAvatarStyle as avatarStyle, projectInitials as initials } from "./avatar.js";
import { mergeAwayIds } from "./sidebarOrder.js";
import { compareWorkingSet, isWorkingSetStatus } from "./workingSet.js";
import { shortenHome } from "./pathDisplay.js";
import { discoveryProjectId } from "./projectRecency.js";
import { PrChipBadge } from "./PrChipBadge.js";
import { needsAttentionCount } from "./prInbox.js";
import { anyLinkUnseen, displayChip, linksTitle, mostUrgentLink, prSummaryLookup, sessionLinks } from "./sessionPrLinks.js";
import appIcon from "../assets/console-c.svg";

const GROUP_VISIBLE = 6;

function groupTintStyle(name: string): CSSProperties {
  const h = hashHue(name);
  return {
    background: `linear-gradient(90deg, hsla(${h}, 35%, 32%, 0.3), hsla(${h}, 35%, 32%, 0) 75%)`
  };
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

const HOVER_DELAY = 350;
const HOVER_FALLBACK_HEIGHT = 280;

type SidebarSection = "main" | "resolved";

interface SidebarOrder {
  main: string[];
  resolved: string[];
  pinned: string[];
}

function orderKeyFor(filter: string): string {
  return `cw:order:${filter}`;
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

export function Sidebar({ onOpenSettings, onOpenSkills, skillsOpen = false }: { onOpenSettings: () => void; onOpenSkills: () => void; skillsOpen?: boolean }) {
  const { projects, sessionsByProject, discoveredByProject, activeProjectId, activeSessionId, gitStatusBySession, projectFilter, worktreeConfirmQueue, homeDir, pendingDriver } = useAppStore();
  const shortPath = (value: string): string => shortenHome(value, homeDir ?? undefined);
  const worktreeConfirm = worktreeConfirmQueue[0] ?? null;
  const store = useAppStore();
  const inbox = usePrStore((s) => s.inbox);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const mainView = usePrStore((s) => s.mainView);
  const openInbox = usePrStore((s) => s.openInbox);
  const openSessionView = usePrStore((s) => s.openSessionView);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [managedId, setManagedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dragged, setDragged] = useState<{ id: string; section: SidebarSection; title: string } | null>(null);
  const [preview, setPreview] = useState<{ targetId: string | null; section: SidebarSection; before: boolean } | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [resolvedOpen, setResolvedOpen] = useState<Set<string>>(new Set());
  const [workingSetOpen, setWorkingSetOpen] = useState(true);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const toggleGroup = (projectId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleExpandGroup = (projectId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleResolved = (projectId: string) => {
    setResolvedOpen((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const hoverModel = useAppStore((s) => (hover ? s.composerBySession[hover.id]?.model : undefined));
  const dragRef = useRef<{ id: string; section: SidebarSection; title: string; startX: number; startY: number; active: boolean } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const scrollTimer = useRef<number | null>(null);
  const pointerY = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const slotSnap = useRef<SlotSnapshot | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, { top: number; height: number }>());
  useLayoutEffect(() => {
    const next = new Map<string, { top: number; height: number }>();
    rowRefs.current.forEach((el, id) => {
      if (!el.isConnected) {
        rowRefs.current.delete(id);
        return;
      }
      const { top, height } = layoutTop(el);
      next.set(id, { top, height });
    });
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      prevRects.current.forEach((prev, id) => {
        const el = rowRefs.current.get(id);
        const cur = next.get(id);
        if (!el || !cur || prev.height === 0 || cur.height === 0) return;
        const dy = prev.top - cur.top;
        if (dy === 0) return;
        el.getAnimations().forEach((a) => a.cancel());
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }], {
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
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
    const focusSearch = () => searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
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

  const filterProject = projectFilter === "all" ? undefined : projects.find((p) => p.id === projectFilter);
  const projectNameById: Record<string, string> = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const source: Session[] =
    projectFilter === "all" ? Object.values(sessionsByProject).flat() : (sessionsByProject[projectFilter] ?? []);
  const discoveredProjectId = discoveryProjectId(projectFilter, activeProjectId);
  const discovered = discoveredProjectId ? (discoveredByProject[discoveredProjectId] ?? []) : [];
  const matchesQuery = (s: Session) =>
    !query || s.title.toLowerCase().includes(query.toLowerCase());
  const byRecency = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
  const workingSetAll = source.filter((s) => isWorkingSetStatus(s.status)).sort(compareWorkingSet);
  const workingSetShown = workingSetAll.filter(matchesQuery);
  const workingSetIds = new Set(workingSetAll.map((s) => s.id));
  const orderKey = orderKeyFor(projectFilter);
  const storedOrder = readStoredOrder(orderKey);
  const storedMain = (storedOrder?.main ?? []).filter((id) => !workingSetIds.has(id));
  const storedResolved = (storedOrder?.resolved ?? []).filter((id) => !workingSetIds.has(id));
  const storedPinned = (storedOrder?.pinned ?? []).filter((id) => !workingSetIds.has(id));
  const pinnedSet = new Set(storedPinned);
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
  const mainAll = source.filter((s) => !workingSetIds.has(s.id) && effectiveSection(s) === "main");
  const resolvedAll = source.filter((s) => !workingSetIds.has(s.id) && effectiveSection(s) === "resolved");
  const orderedMainAll = [...mainAll].sort(byRecency);
  const orderedResolvedAll = storedOrder ? orderByStored(resolvedAll, storedResolved) : [...resolvedAll].sort(byRecency);
  const shown = orderedMainAll.filter(matchesQuery);
  const resolved = orderedResolvedAll.filter(matchesQuery);
  const previewMainAll = previewPlacement(orderedMainAll, orderedResolvedAll, dragged, preview, "main");
  const previewResolvedAll = previewPlacement(orderedMainAll, orderedResolvedAll, dragged, preview, "resolved");
  const previewing = dragged !== null && preview !== null;
  const shownPreview = (previewing ? previewMainAll : orderedMainAll).filter(matchesQuery);
  const resolvedPreview = (previewing ? previewResolvedAll : orderedResolvedAll).filter(matchesQuery);
  const resolvedByProject = new Map<string, Session[]>();
  for (const s of resolvedPreview) {
    const existing = resolvedByProject.get(s.projectId);
    if (existing) existing.push(s);
    else resolvedByProject.set(s.projectId, [s]);
  }
  const inboxItems = inbox?.items ?? [];
  const summaryByKey = prSummaryLookup(inboxItems, detailByKey);
  const attentionCount = needsAttentionCount(inboxItems);
  const anyUnseen = Object.values(sessionsByProject).some((list) => list.some((s) => sessionHasUnseen(s, summaryByKey)));
  const inboxActive = mainView.kind !== "session";
  const newSessionActive = !inboxActive && (pendingDriver !== null || !activeSessionId);
  const liveCount = (list: Session[] | undefined): number => (list ?? []).filter((s) => s.status !== "archived").length;
  const totalCount = Object.values(sessionsByProject).reduce((sum, list) => sum + liveCount(list), 0);
  const inboxNotes = [
    attentionCount > 0 ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} you` : null,
    anyUnseen ? "updates available" : null
  ].filter(Boolean);
  const inboxTitle = ["Pull requests", ...inboxNotes].join(" · ");
  const inboxLabel = ["Pull requests", ...inboxNotes].join(", ");
  const selectSession = (sessionId: string) => {
    openSessionView();
    store.selectSession(sessionId);
  };
  const hoverSession = hover ? (source.find((s) => s.id === hover.id) ?? null) : null;
  const hoverStatus = hoverSession?.status ?? "idle";
  const hoverProject = hoverSession ? (projectNameById[hoverSession.projectId] ?? "") : "";
  const hoverBranch = hoverSession ? (gitStatusBySession[hoverSession.id]?.branch ?? hoverSession.branch) : undefined;

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

  const endPointerDrag = (): void => {
    detachRef.current?.();
    detachRef.current = null;
    stopAutoScroll();
    dragRef.current = null;
    slotSnap.current = null;
    setDragged(null);
    setPreview(null);
  };

  const maybeOpenResolvedGroup = (clientX: number, clientY: number): void => {
    toggleRefs.current.forEach((el, pid) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (clientX < r.left - 4 || clientX > r.right + 4 || clientY < r.top - 4 || clientY > r.bottom + 4) return;
      setResolvedOpen((prev) => (prev.has(pid) ? prev : new Set(prev).add(pid)));
    });
  };
  const visibleProjects = projectQuery
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(projectQuery.toLowerCase()) ||
          p.rootPath.toLowerCase().includes(projectQuery.toLowerCase())
      )
    : projects;

  const closePicker = () => {
    setPickerOpen(false);
    setProjectQuery("");
    setManagedId(null);
  };

  const pick = (id: string | "all") => {
    closePicker();
    store.setProjectFilter(id);
  };

  const pickAndAdd = () => {
    void window.cw
      .pickProjectDir()
      .then((dir) => {
        if (!dir) return;
        return store.addProject(dir).then(() => closePicker());
      })
      .catch((err: Error) => {
        useNotifs.getState().push({ kind: "error", title: "Could not add project", message: err.message });
      });
  };

  const importDiscovered = (session: Session) => {
    void store.importDiscovered(session).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not import session", message: err.message });
    });
  };

  const copyPath = (p: Project) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(p.rootPath)
      .then(() => {
        setCopiedId(p.id);
        window.setTimeout(() => setCopiedId((id) => (id === p.id ? null : id)), 1500);
      })
      .catch(() => {});
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
    void store.renameSession(sessionId, draft).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not rename session", message: err.message });
    });
  };

  const regenerateTitle = (sessionId: string) => {
    setMenu(null);
    void store.regenerateSessionTitle(sessionId).catch((err: Error) => {
      useNotifs.getState().push({ kind: "error", title: "Could not regenerate title", message: err.message });
    });
  };

  const setStatus = (sessionId: string, status: SessionStatus) => {
    setMenu(null);
    void store.setSessionStatus(sessionId, status).catch((err: Error) => {
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
    const prevPinned = readStoredOrder(orderKey)?.pinned ?? storedOrder?.pinned ?? [];
    const pinned = cross ? Array.from(new Set([...prevPinned, fromId])) : [];
    writeStoredOrder(orderKey, {
      main: mergeAwayIds(storedOrder?.main ?? nextMainIds, nextMainIds, workingSetIds),
      resolved: mergeAwayIds(storedOrder?.resolved ?? nextResolvedIds, nextResolvedIds, workingSetIds),
      pinned,
    });
    if (cross) setStatus(fromId, toSection === "main" ? "idle" : "resolved");
    setLandedId(fromId);
    window.setTimeout(() => setLandedId((id) => (id === fromId ? null : id)), 850);
  };

  const renderRow = (s: Session, section: SidebarSection, hideState = false) => {
    const git = gitStatusBySession[s.id];
    const links = sessionLinks(s);
    const gitPr = git?.pullRequest ?? null;
    const urgent = mostUrgentLink(links, summaryByKey, gitPr);
    const chip = urgent ? displayChip(urgent, summaryByKey, gitPr) : null;
    const chipTitle = chip ? (links.length > 1 ? linksTitle(links, summaryByKey, gitPr) : chip.title) : null;
    const unseen = sessionHasUnseen(s, summaryByKey);
    const status = s.status ?? "idle";
    const projectName = projectNameById[s.projectId] ?? "";
    const gitSummary = [
      git?.branch ?? s.branch ? `Branch: ${git?.branch ?? s.branch}` : null,
      git?.worktreePath ?? s.worktreePath ? `Worktree: ${git?.worktreeName ?? shortPath(git?.worktreePath ?? s.worktreePath ?? "")}` : null,
      chipTitle,
      unseen ? "PR updated since last visit" : null,
      git && !git.clean ? `${git.dirtyCount} changed ${git.dirtyCount === 1 ? "file" : "files"}` : null
    ].filter((value): value is string => Boolean(value));
    const rowTitle = [s.title, projectName ? `Project: ${projectName}` : null, ...gitSummary].filter(Boolean).join("\n");
    const beginRowDrag = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("input,button")) return;
      if (renamingId === s.id || query) return;
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
        maybeOpenResolvedGroup(ev.clientX, ev.clientY);
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
        const toggle = el.closest(".session-resolved-toggle") as HTMLElement | null;
        if (el.closest(".resolved-empty-drop") || toggle) {
          const pid = toggle?.dataset.projectId;
          if (pid) setResolvedOpen((prev) => (prev.has(pid) ? prev : new Set(prev).add(pid)));
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
    return <div
      key={s.id}
      ref={(el) => {
        if (el) rowRefs.current.set(s.id, el);
        else rowRefs.current.delete(s.id);
      }}
      onMouseDown={beginRowDrag}
      onMouseEnter={() => scheduleHover(s.id)}
      onMouseLeave={clearHover}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        selectSession(s.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setRenamingId(null);
        setMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
      }}
      className={`session-row${s.id === activeSessionId ? " active" : ""}${dragged?.id === s.id ? " dragging" : ""}${landedId === s.id ? " landed" : ""}${status === "idle" ? " idle" : ""}`}
       aria-label={rowTitle}
    >
      {renamingId === s.id ? (
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
      ) : (
        <span className="session-title">{s.title}</span>
      )}
      <span className="session-side">
        {unseen && <span className="pr-unseen-dot" title="PR updated since last visit" />}
        {chip && <PrChipBadge chip={chip} extra={links.length - 1} title={chipTitle ?? undefined} />}
        {(status === "working" || status === "input-required") && <span className={`session-dot status-${status}`} />}
        {status === "idle" || hideState ? (
          <span className="session-age">{ageLabel(s.updatedAt)}</span>
        ) : (
          <span className={`session-state status-${status}`}>{stateLabel(status)}</span>
        )}
        <DriverIcon driver={s.driver} size={16} />
      </span>
    </div>
  };

  const renderWorkingCard = (s: Session) => {
    const projectName = projectNameById[s.projectId] ?? "";
    const branch = gitStatusBySession[s.id]?.branch ?? s.branch;
    const badge = s.status === "holding" ? ageLabel(s.updatedAt) : stateLabel(s.status);
    return (
      <div
        key={s.id}
        ref={(el) => {
          if (el) rowRefs.current.set(s.id, el);
          else rowRefs.current.delete(s.id);
        }}
        className={`working-card status-${s.status}${s.id === activeSessionId ? " active" : ""}`}
        onMouseEnter={() => scheduleHover(s.id)}
        onMouseLeave={clearHover}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          selectSession(s.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRenamingId(null);
          setMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
        }}
        aria-label={`${s.title}${projectName ? ` · ${projectName}` : ""}`}
      >
        <div className="working-card-head">
          <span className="avatar sm" style={avatarStyle(projectName)}>{initials(projectName)}</span>
          <span className="working-card-project">{projectName}</span>
          <span className={`working-card-badge status-${s.status}`}>{badge}</span>
        </div>
        {renamingId === s.id ? (
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
        ) : (
          <div className="working-card-title">{s.title}</div>
        )}
        <div className="working-card-foot">
          {branch ? (
            <span className="working-card-branch">
              <GitBranch size={11} aria-hidden="true" />
              {branch}
            </span>
          ) : null}
          <DriverIcon driver={s.driver} size={14} />
        </div>
      </div>
    );
  };

  const renderResolvedToggle = (projectId: string, items: Session[]) => {
    if (items.length === 0) return null;
    const open = resolvedOpen.has(projectId);
    return (
      <>
        <button
          type="button"
          className="session-resolved-toggle"
          ref={(el) => {
            if (el) toggleRefs.current.set(projectId, el);
            else toggleRefs.current.delete(projectId);
          }}
          data-project-id={projectId}
          onClick={() => toggleResolved(projectId)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} resolved sessions`}
        >
          <span className="group-chevron" aria-hidden="true">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          Resolved · {items.length}
        </button>
        {open && items.map((s) => renderRow(s, "resolved", true))}
      </>
    );
  };

  const renderRows = (items: Session[], section: SidebarSection) => {
    if (projectFilter !== "all") return items.map((s) => renderRow(s, section));
    const grouped = new Map<string, Session[]>();
    for (const session of items) {
      const existing = grouped.get(session.projectId);
      if (existing) existing.push(session);
      else grouped.set(session.projectId, [session]);
    }
    for (const pid of resolvedByProject.keys()) {
      if (!grouped.has(pid)) grouped.set(pid, []);
    }
    return Array.from(grouped, ([projectId, sessions]) => {
      const project = projects.find((item) => item.id === projectId);
      const name = projectNameById[projectId] ?? "Unknown project";
      const isCollapsed = collapsedGroups.has(projectId);
      const isExpanded = expandedGroups.has(projectId);
      const visible = isExpanded ? sessions : sessions.slice(0, GROUP_VISIBLE);
      const resolved = resolvedByProject.get(projectId) ?? [];
      return (
        <div className="session-project-group" key={`${section}:${projectId}`}>
          <button
            type="button"
            className="session-project-heading"
            style={groupTintStyle(name)}
            title={project?.rootPath ?? name}
            onClick={() => toggleGroup(projectId)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${name}`}
          >
            <span className="group-chevron" aria-hidden="true">
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </span>
            <span className="avatar sm" style={avatarStyle(name)}>{initials(name)}</span>
            <span className="session-project-heading-name">{name}</span>
            <span className="session-project-heading-count">{sessions.length}</span>
          </button>
          {!isCollapsed && (
            <>
              {visible.map((session) => renderRow(session, section))}
              {sessions.length > GROUP_VISIBLE && (
                <button type="button" className="session-show-all" onClick={() => toggleExpandGroup(projectId)}>
                  {isExpanded ? "Show less" : `Show all ${sessions.length}`}
                </button>
              )}
              {renderResolvedToggle(projectId, resolved)}
            </>
          )}
        </div>
      );
    });
  };

  return (
    <div
      className="side"
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
            store.startNewSession();
          }}
          title="New session (Ctrl+T)"
        >
          <Plus size={15} aria-hidden="true" />
          <span>New session</span>
          <span className="side-kbd">Ctrl T</span>
        </button>
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
          <label className="side-nav-row side-nav-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search sessions"
            />
            <span className="side-nav-end">
              {query ? (
                <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
                  <X aria-hidden="true" size={14} />
                </button>
              ) : (
                <span className="side-kbd">Ctrl K</span>
              )}
            </span>
          </label>
        </div>
      </div>
      <div className="side-list-head">
        <span className="side-list-title">Sessions</span>
        <div className="picker side-filter">
          <button
            ref={filterBtnRef}
            type="button"
            className={`side-filter-btn${filterProject ? " filtered" : ""}${pickerOpen ? " open" : ""}`}
            onClick={() => setPickerOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            title="Filter sessions by project"
          >
            <ListFilter size={12} aria-hidden="true" />
            <span className="side-filter-name">{filterProject?.name ?? "All projects"}</span>
            {pickerOpen ? <ChevronUp aria-hidden="true" size={12} /> : <ChevronDown aria-hidden="true" size={12} />}
          </button>
          {pickerOpen && (
            <>
              <div className="picker-backdrop" onClick={closePicker} />
              <div
                className="picker-panel"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    closePicker();
                    filterBtnRef.current?.focus();
                    return;
                  }
                  if (e.key === "Enter" && visibleProjects.length > 0 && document.activeElement?.tagName === "INPUT") {
                    pick(visibleProjects[0].id);
                  }
                }}
              >
                <div className="search-row">
                  <Search className="search-icon" aria-hidden="true" size={15} />
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                    placeholder="Filter by project…"
                  />
                </div>
                <div className="picker-list">
                  <div
                    className={`picker-row${projectFilter === "all" ? " active" : ""}`}
                    onClick={() => pick("all")}
                    aria-current={projectFilter === "all" ? "true" : undefined}
                  >
                    <span className="name">All projects</span>
                    <span className="picker-count">{totalCount}</span>
                  </div>
                  {visibleProjects.map((p) => (
                    <div key={p.id}>
                      <div
                        className={`picker-row${p.id === projectFilter ? " active" : ""}`}
                        onClick={() => pick(p.id)}
                        aria-current={p.id === projectFilter ? "true" : undefined}
                        title={p.rootPath}
                      >
                        <span className="avatar" style={avatarStyle(p.name)}>
                          {initials(p.name)}
                        </span>
                        <span className="name">{p.name}</span>
                        <span className="picker-count">{liveCount(sessionsByProject[p.id])}</span>
                        <button
                          className={`gear${managedId === p.id ? " open" : ""}`}
                          title="Project details"
                          onClick={(e) => {
                            e.stopPropagation();
                            setManagedId((id) => (id === p.id ? null : p.id));
                          }}
                        >
                          <Settings aria-hidden="true" size={14} />
                        </button>
                      </div>
                      {managedId === p.id && (
                        <div className="manage">
                          <span className="path" title={p.rootPath}>
                            {shortPath(p.rootPath)}
                          </span>
                          <button
                            className="btn"
                            style={{ fontSize: 11, padding: "3px 8px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyPath(p);
                            }}
                          >
                            {copiedId === p.id ? <Check aria-hidden="true" size={14} /> : "Copy"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {visibleProjects.length === 0 && <div className="side-empty">No matches.</div>}
                </div>
                <button className="add-project" onClick={pickAndAdd}>
                  Add project…
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="session-list" ref={listRef} onScroll={clearHover}>
        <div className="session-main-list">
          {workingSetShown.length > 0 && (
            <div className="working-set">
              <button
                type="button"
                className="working-set-heading"
                onClick={() => setWorkingSetOpen((o) => !o)}
                aria-expanded={workingSetOpen}
                aria-label={`${workingSetOpen ? "Collapse" : "Expand"} working set`}
              >
                <span className="group-chevron" aria-hidden="true">
                  {workingSetOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span>Working set</span>
                <span className="working-set-count">{workingSetShown.length}</span>
              </button>
              {workingSetOpen && workingSetShown.map((s) => renderWorkingCard(s))}
            </div>
          )}
          {renderRows(shownPreview, "main")}
          {projectFilter !== "all" && renderResolvedToggle(projectFilter, resolvedPreview)}
          {shownPreview.length === 0 && resolvedPreview.length === 0 && workingSetShown.length === 0 && (
            <div className="side-empty">{query ? "No matches." : "No sessions yet."}</div>
          )}
        </div>
        {resolvedPreview.length === 0 && dragged && (
          <div
            className="resolved-empty-drop"
          >Drop here to resolve</div>
        )}
        {discovered.length > 0 && (
          <details className="discovered">
            <summary>from cli · {discovered.length}</summary>
            {discovered.map((s) => (
              <div key={s.id} className="discovered-row" title={s.title}>
                <DriverIcon driver={s.driver} size={14} />
                <span className="session-title">{s.title}</span>
                <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => importDiscovered(s)} title="Import into cw-code">
                  Import
                </button>
              </div>
            ))}
          </details>
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
                const target = [...workingSetShown, ...shown, ...resolved].find((s) => s.id === menu.sessionId);
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
      {worktreeConfirm && (
        <>
          <div className="ctx-backdrop" onClick={() => store.dismissWorktreeRemoval()} />
          <div
            className="ctx-menu worktree-confirm"
            style={{ left: Math.max(12, window.innerWidth / 2 - 140), top: window.innerHeight / 2 - 70 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="worktree-confirm-title">Remove the worktree too?</div>
            <div className="worktree-confirm-hint">
              {[...workingSetShown, ...shown, ...resolved].find((s) => s.id === worktreeConfirm.sessionId)?.title ??
                worktreeConfirm.sessionId}{" "}
              is {worktreeConfirm.status === "archived" ? "archived" : "resolved"} and no other session uses its isolated worktree.
            </div>
            {typeof worktreeConfirm.unmergedCommitCount === "number" && worktreeConfirm.unmergedCommitCount > 0 && (
              <div className="worktree-confirm-warning">
                This branch has {worktreeConfirm.unmergedCommitCount} unmerged{" "}
                {worktreeConfirm.unmergedCommitCount === 1 ? "commit" : "commits"} that will be permanently deleted.
              </div>
            )}
            <button className="ctx-item" onClick={() => void store.confirmWorktreeRemoval()}>
              Remove worktree and branch
            </button>
            <button className="ctx-item" onClick={() => store.dismissWorktreeRemoval()}>
              Keep it
            </button>
          </div>
        </>
      )}
      <div className="side-footer">
        <button className="side-footer-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          <Settings size={15} />
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
