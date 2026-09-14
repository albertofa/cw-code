import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, Clock, Folder, GitBranch, Hash, Plus, RefreshCw, Search, Settings, X } from "lucide-react";
import type { DriverName, Project, Session, SessionStatus } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { useNotifs } from "./Notifications.js";

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase() || "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const GROUP_VISIBLE = 6;

function groupTintStyle(name: string): CSSProperties {
  const h = hashHue(name);
  return {
    background: `linear-gradient(90deg, hsla(${h}, 35%, 32%, 0.3), hsla(${h}, 35%, 32%, 0) 75%)`
  };
}

function avatarStyle(name: string): CSSProperties {
  return { background: `hsl(${hashHue(name)}, 32%, 36%)` };
}

function stateLabel(status: SessionStatus): string {
  if (status === "input-required") return "Input";
  if (status === "working") return "Running";
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

const HOVER_DELAY = 350;
const HOVER_FALLBACK_HEIGHT = 280;

type SidebarSection = "main" | "resolved";

interface SidebarOrder {
  main: string[];
  resolved: string[];
  snap: Record<string, number>;
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
    const snap = parsed.snap && typeof parsed.snap === "object" ? (parsed.snap as Record<string, number>) : {};
    const pinned = Array.isArray(parsed.pinned) ? parsed.pinned.filter((id): id is string => typeof id === "string") : [];
    return {
      main: parsed.main.filter((id): id is string => typeof id === "string"),
      resolved: parsed.resolved.filter((id): id is string => typeof id === "string"),
      snap,
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

function isStoredOrderValid(mainAll: Session[], resolvedAll: Session[], stored: SidebarOrder): boolean {
  if (stored.main.length !== mainAll.length || stored.resolved.length !== resolvedAll.length) return false;
  if (new Set(stored.main).size !== stored.main.length) return false;
  if (new Set(stored.resolved).size !== stored.resolved.length) return false;
  const mainIds = new Set(mainAll.map((s) => s.id));
  const resolvedIds = new Set(resolvedAll.map((s) => s.id));
  const storedMain = new Set(stored.main);
  const storedResolved = new Set(stored.resolved);
  if (stored.main.some((id) => !mainIds.has(id)) || stored.resolved.some((id) => !resolvedIds.has(id))) return false;
  if (mainAll.some((s) => !storedMain.has(s.id)) || resolvedAll.some((s) => !storedResolved.has(s.id))) return false;
  if (stored.main.some((id) => storedResolved.has(id))) return false;
  const pinned = new Set(stored.pinned);
  for (const s of [...mainAll, ...resolvedAll]) {
    if (pinned.has(s.id)) continue;
    if (stored.snap[s.id] !== s.updatedAt) return false;
  }
  return true;
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { projects, sessionsByProject, discoveredByProject, activeProjectId, activeSessionId, gitStatusBySession, projectFilter, worktreeConfirmQueue } = useAppStore();
  const worktreeConfirm = worktreeConfirmQueue[0] ?? null;
  const store = useAppStore();
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

  const refreshAll = () => {
    void store.loadProjects();
    void store.loadDiscovered();
  };

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const filterProject = projectFilter === "all" ? undefined : projects.find((p) => p.id === projectFilter);
  const projectNameById: Record<string, string> = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const source: Session[] =
    projectFilter === "all" ? Object.values(sessionsByProject).flat() : (sessionsByProject[projectFilter] ?? []);
  const discovered = activeProjectId ? (discoveredByProject[activeProjectId] ?? []) : [];
  const matchesQuery = (s: Session) =>
    !query || s.title.toLowerCase().includes(query.toLowerCase());
  const byRecency = (a: Session, b: Session) => b.updatedAt - a.updatedAt;
  const orderKey = orderKeyFor(projectFilter);
  const storedOrder = readStoredOrder(orderKey);
  const pinnedSet = new Set(storedOrder?.pinned ?? []);
  const storedMainSet = new Set(storedOrder?.main ?? []);
  const storedResolvedSet = new Set(storedOrder?.resolved ?? []);
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
  const mainAll = source.filter((s) => effectiveSection(s) === "main");
  const resolvedAll = source.filter((s) => effectiveSection(s) === "resolved");
  const storedValid = storedOrder ? isStoredOrderValid(mainAll, resolvedAll, storedOrder) : false;
  const orderedMainAll =
    storedValid && storedOrder ? orderByStored(mainAll, storedOrder.main) : [...mainAll].sort(byRecency);
  const orderedResolvedAll =
    storedValid && storedOrder ? orderByStored(resolvedAll, storedOrder.resolved) : [...resolvedAll].sort(byRecency);
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

  const pick = (id: string) => {
    closePicker();
    void store.selectProject(id);
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
    const snap: Record<string, number> = {};
    for (const s of [...nextMain, ...nextResolved]) snap[s.id] = s.updatedAt;
    const cross = fromSection !== toSection;
    const prevPinned = readStoredOrder(orderKey)?.pinned ?? storedOrder?.pinned ?? [];
    const pinned = cross ? Array.from(new Set([...prevPinned, fromId])) : [];
    writeStoredOrder(orderKey, {
      main: nextMain.map((s) => s.id),
      resolved: nextResolved.map((s) => s.id),
      snap,
      pinned,
    });
    if (cross) setStatus(fromId, toSection === "main" ? "idle" : "resolved");
    setLandedId(fromId);
    window.setTimeout(() => setLandedId((id) => (id === fromId ? null : id)), 850);
  };

  const renderRow = (s: Session, section: SidebarSection, hideState = false) => {
    const git = gitStatusBySession[s.id];
    const pr = git?.pullRequest;
    const prState = pr?.isDraft
      ? "draft"
      : pr?.state !== "OPEN"
        ? pr?.state.toLowerCase()
        : pr?.checks.failed
          ? "failing"
          : pr?.checks.pending
            ? "pending"
            : pr?.reviewDecision === "APPROVED"
              ? "approved"
              : pr?.reviewDecision === "CHANGES_REQUESTED" ? "changes-requested" : "open";
    const status = s.status ?? "idle";
    const projectName = projectNameById[s.projectId] ?? "";
    const gitSummary = [
      git?.branch ?? s.branch ? `Branch: ${git?.branch ?? s.branch}` : null,
      git?.worktreePath ?? s.worktreePath ? `Worktree: ${git?.worktreeName ?? git?.worktreePath ?? s.worktreePath}` : null,
      pr ? `PR #${pr.number} ${prState?.replace("-", " ") ?? ""}`.trim() : null,
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
        store.selectSession(s.id);
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
        <DriverIcon driver={s.driver} size={12} />
        {(status === "working" || status === "input-required") && <span className={`session-dot status-${status}`} />}
        {status === "idle" || hideState ? (
          <span className="session-age">{ageLabel(s.updatedAt)}</span>
        ) : (
          <span className={`session-state status-${status}`}>{stateLabel(status)}</span>
        )}
      </span>
    </div>
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
      <div className="brand">
        <div className="search-row ghost">
          <Search className="search-icon" aria-hidden="true" size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
          />
          {query ? (
            <button className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              <X aria-hidden="true" size={15} />
            </button>
          ) : (
            <span className="search-kbd">Ctrl+K</span>
          )}
        </div>
        <div className="project-bar">
          <div className="picker">
            <button className="picker-btn" onClick={() => setPickerOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={pickerOpen}>
            <Folder className="picker-icon" aria-hidden="true" size={16} />
            <span className="picker-name">{projectFilter === "all" ? "All projects" : (filterProject?.name ?? activeProject?.name ?? "Select project…")}</span>
            <span className="picker-chevron">{pickerOpen ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}</span>
          </button>
          {pickerOpen && (
            <>
              <div className="picker-backdrop" onClick={closePicker} />
              <div
                className="picker-panel"
                role="listbox"
                onKeyDown={(e) => {
                  if (e.key === "Escape") closePicker();
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
                    placeholder="Search projects…"
                  />
                </div>
                <div className="picker-list">
                  <div
                    className={`picker-row${projectFilter === "all" ? " active" : ""}`}
                    onClick={() => {
                      closePicker();
                      store.setProjectFilter("all");
                    }}
                    role="option"
                    aria-selected={projectFilter === "all"}
                  >
                    <span className="name">All projects</span>
                  </div>
                  {visibleProjects.map((p) => (
                    <div key={p.id}>
                      <div
                        className={`picker-row${p.id === projectFilter ? " active" : ""}`}
                        onClick={() => pick(p.id)}
                        role="option"
                        aria-selected={p.id === projectFilter}
                        title={p.rootPath}
                      >
                        <span className="avatar" style={avatarStyle(p.name)}>
                          {initials(p.name)}
                        </span>
                        <span className="name">{p.name}</span>
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
                            {p.rootPath}
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
          <button
            className="new-session-btn"
            disabled={!activeProjectId}
            onClick={() => store.startNewSession()}
            title={`New session in ${activeProject?.name ?? "…"}`}
            aria-label="New session"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <div className="session-list" ref={listRef} onScroll={clearHover}>
        <div className="session-main-list">
          {renderRows(shownPreview, "main")}
          {projectFilter !== "all" && renderResolvedToggle(projectFilter, resolvedPreview)}
          {shownPreview.length === 0 && resolvedPreview.length === 0 && (
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
                <DriverIcon driver={s.driver} size={10} />
                <span className="session-title">{s.title}</span>
                <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => void store.importDiscovered(s)} title="Import into cw-code">
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
                const target = [...shown, ...resolved].find((s) => s.id === menu.sessionId);
                setRenameDraft(target?.title ?? "");
                setRenamingId(menu.sessionId);
                setMenu(null);
              }}
            >
              Rename
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
              {[...shown, ...resolved].find((s) => s.id === worktreeConfirm.sessionId)?.title ??
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
          Settings
        </button>
        <button className="side-footer-btn" title="Refresh projects and sessions" aria-label="Refresh" onClick={refreshAll}>
          <RefreshCw size={14} />
          Refresh
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
            <DriverIcon driver={hoverSession.driver} size={12} />
            <span className="hovercard-text">
              {hoverModel ?? "Default model"} · {DRIVER_LABEL[hoverSession.driver]}
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
