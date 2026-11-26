import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Folder, GitBranch } from "lucide-react";
import type { HistoryCommit, HistoryLog, HistoryScope, HistoryWorktree } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { MenuSelect, type MenuOption } from "../MenuSelect.js";
import { FileIcon } from "../fileIcons.js";
import { splitRepoPath } from "../turnChanges.js";
import { relativeTime } from "../prDetailModel.js";
import { useSessionLinkedPrs } from "../PrSessionPanel.js";
import type { DiffFile } from "../diffParser.js";
import { FileStats, formatCommitDate, type HistoryCommitState } from "./HistoryCommitView.js";
import { CommitPulls } from "./CommitPulls.js";
import { RefIcons, refLabelAt } from "./HistoryGraph.js";
import { colorOfEmail, initialsOf } from "./historyAvatars.js";
import { changedFileTree } from "./changedFileTree.js";
import { usePersistedChoice } from "./usePersistedState.js";

const FILE_VIEWS = ["list", "tree"] as const;
type FileView = (typeof FILE_VIEWS)[number];
const TREE_INDENT = 12;

function useLinkedPrKeys(sessionId: string | null): ReadonlySet<string> {
  const linked = useSessionLinkedPrs(sessionId);
  return useMemo(() => new Set(linked.map((item) => prKey(item.ref))), [linked]);
}

function Avatar({ name, email, url }: { name: string; email: string; url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) return <img className="gg-avatar" src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return (
    <span className="gg-avatar" style={{ background: colorOfEmail(email) }} aria-hidden="true">
      {initialsOf(name, email)}
    </span>
  );
}

export function FileRow({ file, depth, shown, onOpen }: { file: DiffFile; depth: number | null; shown: boolean; onOpen: () => void }) {
  const { dir, name } = splitRepoPath(file.path);
  return (
    <button
      type="button"
      role="listitem"
      className={`gg-file${shown ? " shown" : ""}`}
      style={depth === null ? undefined : { paddingLeft: 6 + depth * TREE_INDENT }}
      onClick={onOpen}
      title={file.path}
    >
      <FileIcon name={name} size={13} />
      <span className="gg-file-name">{name}</span>
      {depth === null && dir && <span className="gg-file-dir">{dir}</span>}
      <span className="gg-file-end">
        <FileStats file={file} />
      </span>
    </button>
  );
}

function ChangedFiles({
  files,
  isMerge,
  truncated,
  openPath,
  onOpenFile
}: {
  files: DiffFile[];
  isMerge: boolean;
  truncated: boolean;
  openPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [view, setView] = usePersistedChoice<FileView>("cw-code:git-glass-files-view", FILE_VIEWS, "list");
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const tree = useMemo(() => (view === "tree" ? changedFileTree(files.map((file) => file.path)) : []), [view, files]);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <section className="gg-d-sec" aria-label="Changed files">
      <h4 className="gg-d-h">
        Changed files
        <span className="gg-d-h-count">
          {files.length}
          {isMerge ? " · vs first parent" : ""}
        </span>
        <span className="gg-d-h-end">
          <span className="gg-seg" role="group" aria-label="File layout">
            {FILE_VIEWS.map((option) => (
              <button key={option} type="button" aria-pressed={view === option} className={view === option ? "on" : undefined} onClick={() => setView(option)}>
                {option === "list" ? "List" : "Tree"}
              </button>
            ))}
          </span>
        </span>
      </h4>
      <div className="gg-files-summary">
        <span className="add">+{added}</span>
        <span className="del">−{removed}</span>
      </div>
      {truncated && <div className="gg-note">This commit is too large to show in full; later files are cut off.</div>}
      {files.length === 0 && <div className="gg-note">No file changes</div>}
      <div className="gg-files" role="list" aria-label="Changed files">
        {view === "list" &&
          files.map((file) => <FileRow key={file.path} file={file} depth={null} shown={file.path === openPath} onOpen={() => onOpenFile(file.path)} />)}
        {view === "tree" &&
          tree.map((row) => {
            if (row.kind === "dir") {
              return (
                <div key={`dir:${row.path}`} className="gg-file-folder" role="listitem" style={{ paddingLeft: 6 + row.depth * TREE_INDENT }} title={row.path}>
                  <Folder size={13} aria-hidden="true" />
                  <span className="gg-file-name">{row.name}</span>
                </div>
              );
            }
            const file = byPath.get(row.path);
            if (!file) return null;
            return <FileRow key={file.path} file={file} depth={row.depth} shown={file.path === openPath} onOpen={() => onOpenFile(file.path)} />;
          })}
      </div>
    </section>
  );
}

function checkoutOptions(log: HistoryLog, sha: string, worktreeBranches: ReadonlyMap<string, HistoryWorktree>): MenuOption[] {
  const label = refLabelAt(log, sha);
  const seen = new Set<string>();
  const options: MenuOption[] = [];
  for (const entry of label?.entries ?? []) {
    if (entry.checkout === null || entry.isCurrent || seen.has(entry.checkout)) continue;
    seen.add(entry.checkout);
    const elsewhere = worktreeBranches.get(entry.checkout);
    options.push({
      id: entry.checkout,
      label: entry.name,
      description: elsewhere
        ? `Checked out in the worktree ${elsewhere.name} — opens its history`
        : entry.kind === "remote"
          ? `git switch --track ${entry.checkout}`
          : `git switch ${entry.checkout}`,
      icon: <GitBranch size={13} />
    });
  }
  return options;
}

export function CommitDetails({
  scope,
  sessionId,
  log,
  sha,
  commit,
  avatars,
  showAvatars,
  openPath,
  onOpenFile,
  onSelectCommit,
  onCheckout,
  busy,
  worktreeBranches
}: {
  scope: HistoryScope;
  sessionId: string | null;
  log: HistoryLog;
  sha: string;
  commit: HistoryCommitState;
  avatars: Record<string, string | null>;
  showAvatars: boolean;
  openPath: string | null;
  onOpenFile: (path: string) => void;
  onSelectCommit: (sha: string) => void;
  onCheckout: (branch: string) => void;
  busy: boolean;
  worktreeBranches: ReadonlyMap<string, HistoryWorktree>;
}) {
  const linkedKeys = useLinkedPrKeys(sessionId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const listed = useMemo<HistoryCommit | undefined>(() => log.commits.find((candidate) => candidate.sha === sha), [log, sha]);
  const detail = commit.detail?.sha === sha ? commit.detail : null;
  const base = detail ?? listed ?? null;
  const label = useMemo(() => refLabelAt(log, sha), [log, sha]);
  const checkouts = useMemo(() => checkoutOptions(log, sha, worktreeBranches), [log, sha, worktreeBranches]);
  const nowMs = useMemo(() => Date.now(), [sha]);

  useEffect(() => {
    setCopied(false);
    setCopyError("");
  }, [sha]);

  const copySha = (): void => {
    setCopyError("");
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyError("Copying is not available here (the clipboard needs a secure connection)");
      return;
    }
    try {
      clipboard.writeText(sha).then(
        () => setCopied(true),
        () => setCopyError("Could not copy the commit id")
      );
    } catch {
      setCopyError("Could not copy the commit id");
    }
  };

  const email = base?.authorEmail.toLowerCase() ?? "";
  const sameCommitter = detail ? detail.committerEmail === detail.authorEmail && detail.committerName === detail.authorName : true;

  return (
    <div className="gg-commit">
      {base ? <h2 className="gg-d-title">{base.subject}</h2> : <div className="gg-note">Loading commit…</div>}
      {detail?.body && <pre className="gg-d-text">{detail.body}</pre>}
      {label && (
        <div className="gg-ref-chips">
          {label.entries.map((entry) => (
            <span key={entry.key} className={`gg-ref-chip ${entry.kind}${entry.isCurrent ? " current" : ""}`} title={entry.name}>
              <RefIcons kind={entry.kind} isCurrent={entry.isCurrent} hasLocal={false} hasRemote={false} />
              {entry.name}
            </span>
          ))}
        </div>
      )}

      <CommitPulls scope={scope} sha={sha} linkedKeys={linkedKeys} />

      {base && (
        <section className="gg-d-sec" aria-label="Author">
          <h4 className="gg-d-h">Author</h4>
          <div className="gg-author">
            <Avatar key={email} name={base.authorName} email={email} url={showAvatars ? (avatars[email] ?? null) : null} />
            <div className="gg-author-text">
              <div className="gg-author-name">{base.authorName}</div>
              <div className="gg-author-meta" title={formatCommitDate(base.authorDate)}>
                {base.authorEmail} · {relativeTime(base.authorDate * 1000, nowMs)}
              </div>
              {detail && !sameCommitter && (
                <div className="gg-author-meta" title={formatCommitDate(detail.committerDate)}>
                  Committed by {detail.committerName} · {relativeTime(detail.committerDate * 1000, nowMs)}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="gg-d-sec" aria-label="Commit details">
        <h4 className="gg-d-h">Details</h4>
        <div className="gg-kv">
          <span>SHA</span>
          <span className="gg-kv-value">
            <span className="gg-sha">{sha}</span>
            <button type="button" className="gg-icon-btn" onClick={copySha} title="Copy commit id" aria-label="Copy commit id">
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            </button>
          </span>
          {base && base.parents.length > 0 && (
            <>
              <span>{base.parents.length > 1 ? "Parents" : "Parent"}</span>
              <span className="gg-kv-value">
                {base.parents.map((parent) => (
                  <button key={parent} type="button" className="gg-chip" onClick={() => onSelectCommit(parent)} title={`Select ${parent}`}>
                    {parent.slice(0, 7)}
                  </button>
                ))}
              </span>
            </>
          )}
        </div>
        {copyError && (
          <div className="gg-error-text" role="alert">
            {copyError}
          </div>
        )}
      </section>

      <section className="gg-d-sec" aria-label="Actions">
        <h4 className="gg-d-h">Actions</h4>
        <div className="gg-actions">
          {checkouts.length > 0 && !busy ? (
            <MenuSelect
              label="Check out a branch at this commit"
              title="Check out a branch that points at this commit"
              direction="down"
              value=""
              display="Check out…"
              icon={<GitBranch size={12} aria-hidden="true" />}
              options={checkouts}
              onPick={onCheckout}
            />
          ) : (
            <button
              type="button"
              className="gg-action"
              aria-disabled="true"
              title={busy ? "Wait for the running action to finish" : "No other branch points at this commit"}
            >
              <GitBranch size={12} aria-hidden="true" />
              Check out…
            </button>
          )}
          <button type="button" className="gg-action" onClick={copySha}>
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            Copy SHA
          </button>
        </div>
      </section>

      {commit.error ? (
        <div className="inspect-error">Commit unavailable: {commit.error}</div>
      ) : detail ? (
        <ChangedFiles files={commit.files} isMerge={detail.parents.length > 1} truncated={detail.patchTruncated} openPath={openPath} onOpenFile={onOpenFile} />
      ) : (
        <div className="gg-note">Loading changed files…</div>
      )}
    </div>
  );
}
