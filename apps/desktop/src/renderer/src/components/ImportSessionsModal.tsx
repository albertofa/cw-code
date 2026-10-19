import { useEffect, useState, type CSSProperties } from "react";
import { Download, Folder, FolderPlus, GitBranch, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { DriverName, ImportableSession } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { DriverIcon } from "./DriverIcon.js";
import { GitHubMark } from "./GitHubMark.js";
import { pickableHarnesses } from "./harnessAvailability.js";
import { filterImportable } from "./importSearch.js";
import { Bone, SkeletonRegion } from "./Loading.js";
import { MenuSelect } from "./MenuSelect.js";
import { shortenHome } from "./pathDisplay.js";
import { formatRelativeAge } from "./prInboxModel.js";

const HARNESS_LABELS: Record<DriverName, string> = {
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex"
};

type Listing =
  | { status: "loading" }
  | { status: "ready"; items: ImportableSession[] }
  | { status: "error"; error: string };

const SKELETON_TITLE_WIDTHS = ["58%", "42%", "66%", "37%", "52%", "46%", "61%", "34%"];
const SKELETON_META_WIDTHS = [[72, 96, 64], [88, 54], [64, 110, 72], [80], [70, 90, 58], [96, 60]];

function ImportListSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <ul className="import-list">
        {SKELETON_TITLE_WIDTHS.map((title, i) => (
          <li key={i} className="import-row" style={{ "--i": i } as CSSProperties}>
            <div className="import-row-main">
              <div className="skel-line import-skel-title">
                <Bone w={title} h={11} />
              </div>
              <div className="skel-line import-skel-meta">
                {SKELETON_META_WIDTHS[i % SKELETON_META_WIDTHS.length].map((w, j) => (
                  <Bone key={j} w={w} h={8} />
                ))}
              </div>
            </div>
            <Bone w={88} h={30} className="import-skel-btn" />
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );
}

function ImportRow({
  session,
  homeDir,
  now,
  busy,
  disabled,
  onImport
}: {
  session: ImportableSession;
  homeDir: string | undefined;
  now: number;
  busy: boolean;
  disabled: boolean;
  onImport: () => void;
}) {
  return (
    <li className="import-row">
      <div className="import-row-main">
        <div className="import-row-title" title={session.title}>{session.title}</div>
        <div className="import-row-meta">
          <span className="import-meta" title={shortenHome(session.cwd, homeDir)}>
            <Folder size={12} aria-hidden="true" />
            {session.projectName}
          </span>
          {session.repository && (
            <span className="import-meta">
              <GitHubMark size={12} />
              {session.repository}
            </span>
          )}
          {session.gitBranch && (
            <span className="import-meta">
              <GitBranch size={12} aria-hidden="true" />
              {session.gitBranch}
            </span>
          )}
          <span className="import-meta">{formatRelativeAge(session.updatedAt, now)} ago</span>
          {!session.projectId && (
            <span className="import-new-project" title={`Adds ${shortenHome(session.cwd, homeDir)} as a project`}>
              <FolderPlus size={11} aria-hidden="true" />
              new project
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="btn import-row-btn"
        onClick={onImport}
        disabled={disabled}
        aria-label={`Import ${session.title}`}
      >
        {busy ? <Loader2 size={14} className="skills-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
        Import
      </button>
    </li>
  );
}

export function ImportSessionsModal({ initialDriver, onClose }: { initialDriver: DriverName; onClose: () => void }) {
  const installed = useAppStore((s) => s.installedHarnesses);
  const homeDir = useAppStore((s) => s.homeDir) ?? undefined;
  const importSession = useAppStore((s) => s.importSession);
  const harnesses = pickableHarnesses(installed);
  const [driver, setDriver] = useState<DriverName>(harnesses.includes(initialDriver) ? initialDriver : harnesses[0]);
  const [listings, setListings] = useState<Partial<Record<DriverName, Listing>>>({});
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState("");

  const load = (target: DriverName) => {
    setListings((prev) => ({ ...prev, [target]: { status: "loading" } }));
    window.cw.listImportableSessions(target).then(
      (items) => setListings((prev) => ({ ...prev, [target]: { status: "ready", items } })),
      (err: Error) => setListings((prev) => ({ ...prev, [target]: { status: "error", error: err.message } }))
    );
  };

  useEffect(() => {
    if (!listings[driver]) load(driver);
  }, [driver]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && importing === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importing, onClose]);

  const runImport = async (session: ImportableSession) => {
    if (importing !== null) return;
    setImporting(session.resumeCursor);
    setImportError("");
    try {
      await importSession({ driver: session.driver, resumeCursor: session.resumeCursor });
      onClose();
    } catch (err) {
      setImportError((err as Error).message);
      setImporting(null);
    }
  };

  const listing = listings[driver] ?? { status: "loading" };
  const visible = listing.status === "ready" ? filterImportable(listing.items, query) : [];
  const now = Date.now();
  const close = () => {
    if (importing === null) onClose();
  };

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="settings-modal import-modal" role="dialog" aria-label="Import session" onClick={(e) => e.stopPropagation()}>
        <div className="import-toolbar">
          <div className="import-harness">
            <MenuSelect
              label="Harness"
              title="Choose which harness to import from"
              direction="down"
              value={driver}
              display={HARNESS_LABELS[driver]}
              icon={<DriverIcon driver={driver} size={14} />}
              options={harnesses.map((id) => ({
                id,
                label: HARNESS_LABELS[id],
                icon: <DriverIcon driver={id} size={13} />
              }))}
              onPick={(id) => setDriver(id as DriverName)}
            />
          </div>
          <label className="side-search import-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder="Search title, project, folder, repository, branch…"
              aria-label="Search sessions"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>
          <button type="button" className="icon-btn import-close" aria-label="Close import" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {importError && (
          <div className="wf-run-error import-error" role="alert">
            {importError}
          </div>
        )}
        <div className="import-body">
          {listing.status === "loading" && <ImportListSkeleton label={`Loading ${HARNESS_LABELS[driver]} sessions`} />}
          {listing.status === "error" && (
            <div className="skills-list-error">
              <div className="settings-error">Could not list {HARNESS_LABELS[driver]} sessions: {listing.error}</div>
              <button type="button" className="btn" onClick={() => load(driver)}>
                Retry
              </button>
            </div>
          )}
          {listing.status === "ready" && visible.length === 0 && (
            <div className="side-empty">
              {query.trim() ? "No matches." : `No ${HARNESS_LABELS[driver]} sessions to import.`}
            </div>
          )}
          {visible.length > 0 && (
            <ul className="import-list">
              {visible.map((session) => (
                <ImportRow
                  key={session.resumeCursor}
                  session={session}
                  homeDir={homeDir}
                  now={now}
                  busy={importing === session.resumeCursor}
                  disabled={importing !== null}
                  onImport={() => void runImport(session)}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="import-foot">
          <span className="import-foot-text">
            {listing.status === "ready" && listing.items.length > 0
              ? `${query.trim() ? `${visible.length} of ${listing.items.length}` : listing.items.length} session${listing.items.length === 1 ? "" : "s"} · sessions already in cw-code are hidden`
              : "Sessions already in cw-code are hidden"}
          </span>
          <button
            type="button"
            className="import-reload"
            onClick={() => load(driver)}
            disabled={listing.status === "loading"}
            title={`Reload ${HARNESS_LABELS[driver]} sessions`}
          >
            <RefreshCw size={12} className={listing.status === "loading" ? "skills-spin" : undefined} aria-hidden="true" />
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
