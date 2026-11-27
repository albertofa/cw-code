import { ArrowDown, ArrowUp, Cloud, CloudDownload, Folder, GitBranch, GitCommitHorizontal, MessagesSquare } from "lucide-react";
import { relativeTime } from "../prDetailModel.js";
import { useNow } from "../usageFormat.js";

export interface StatusUpstream {
  name: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface StatusSessions {
  total: number;
  running: number;
  onOpen: () => void;
}

const countFormat = new Intl.NumberFormat("en-US");
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function FetchedLabel({ fetchedAt, busy, onFetch }: { fetchedAt: number | null; busy: boolean; onFetch: () => void }) {
  const now = useNow();
  const label = fetchedAt === null ? "Never fetched" : `Fetched ${relativeTime(fetchedAt, now)}`;
  const when = fetchedAt === null ? "This checkout has never been fetched" : `Last fetched ${timeFormat.format(fetchedAt)}`;
  return (
    <button
      type="button"
      className="gg-st-item gg-st-link"
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onFetch}
      title={busy ? `${when} — wait for the running action to finish` : `${when} — click to fetch now`}
    >
      <CloudDownload size={12} aria-hidden="true" />
      {label}
    </button>
  );
}

export function GitGlassStatusBar({
  branch,
  upstream,
  fetchedAt,
  busy,
  onFetch,
  sessions,
  commits,
  truncated,
  path,
  onOpenPath
}: {
  branch: string | null;
  upstream: StatusUpstream | null;
  fetchedAt: number | null;
  busy: boolean;
  onFetch: () => void;
  sessions: StatusSessions | null;
  commits: number | null;
  truncated: boolean;
  path: string | null;
  onOpenPath: (() => void) | null;
}) {
  return (
    <div className="gg-statusbar">
      {branch && (
        <span className="gg-st-item" title={branch}>
          <GitBranch size={12} aria-hidden="true" />
          {branch}
        </span>
      )}
      {upstream && (
        <span className="gg-st-item" title={upstream.gone ? `${upstream.name} no longer exists` : `Tracking ${upstream.name}`}>
          <Cloud size={12} aria-hidden="true" />
          {upstream.name}
          {upstream.gone ? (
            <span className="gg-st-warn">gone</span>
          ) : (
            <>
              <span className="gg-st-count" aria-label={`${upstream.ahead} ahead`}>
                <ArrowUp size={11} aria-hidden="true" />
                {upstream.ahead}
              </span>
              <span className="gg-st-count" aria-label={`${upstream.behind} behind`}>
                <ArrowDown size={11} aria-hidden="true" />
                {upstream.behind}
              </span>
            </>
          )}
        </span>
      )}
      <FetchedLabel fetchedAt={fetchedAt} busy={busy} onFetch={onFetch} />
      {sessions && sessions.total > 0 && (
        <button type="button" className="gg-st-item gg-st-link gg-wide-only" onClick={sessions.onOpen} title="Show this project's sessions">
          <MessagesSquare size={12} aria-hidden="true" />
          {sessions.total} {sessions.total === 1 ? "session" : "sessions"} · {sessions.running} running
        </button>
      )}
      <span className="gg-st-spacer" />
      {commits !== null && (
        <span className="gg-st-item gg-wide-only">
          <GitCommitHorizontal size={12} aria-hidden="true" />
          {countFormat.format(commits)}
          {truncated ? "+" : ""} {commits === 1 && !truncated ? "commit" : "commits"}
        </span>
      )}
      {path &&
        (onOpenPath ? (
          <button type="button" className="gg-st-item gg-st-link gg-wide-only gg-st-path" onClick={onOpenPath} title={`Open ${path}`}>
            <Folder size={12} aria-hidden="true" />
            <span className="gg-st-path-text">{path}</span>
          </button>
        ) : (
          <span className="gg-st-item gg-wide-only gg-st-path" title={path}>
            <Folder size={12} aria-hidden="true" />
            <span className="gg-st-path-text">{path}</span>
          </span>
        ))}
    </div>
  );
}
