import { ArrowDown, ArrowUp, Cloud, Folder, GitBranch, GitCommitHorizontal } from "lucide-react";

export interface StatusUpstream {
  name: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

const countFormat = new Intl.NumberFormat("en-US");

export function GitGlassStatusBar({
  branch,
  upstream,
  commits,
  truncated,
  path,
  onOpenPath
}: {
  branch: string | null;
  upstream: StatusUpstream | null;
  commits: number | null;
  truncated: boolean;
  path: string | null;
  onOpenPath: (() => void) | null;
}) {
  return (
    <div className="gg-statusbar" role="status">
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
