import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleDashed, CircleDot, Monitor, ShieldAlert, Wrench, X, type LucideIcon } from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";
import { useAppStore } from "../stores/appStore.js";
import {
  describeToolCall,
  extractCommandFragment,
  extractFileDiff,
  extractFileDiffFromText,
  extractFileFragment,
  formatDuration,
  formatToolDuration,
  recoverToolInput,
  relativizeInText,
  stripToolNamePrefix,
  toolSpanMs
} from "./toolSummaries.js";
import { formatFileSubject, looksLikeFileMention, shortenHomeInText, stripMentionMarker } from "./pathDisplay.js";
import { FileIcon } from "./fileIcons.js";
import { isPreviewablePath } from "./Markdown.js";
import { useElapsed } from "./useElapsed.js";

export type ToolStatus = "complete" | "error" | "running" | "waiting" | "pending";

const STATUS_LABEL: Record<ToolStatus, string> = {
  complete: "Done",
  error: "Failed",
  running: "Running",
  waiting: "Waiting for approval",
  pending: "Pending"
};

const STATUS_ICON: Record<Exclude<ToolStatus, "complete">, LucideIcon> = {
  error: X,
  running: CircleDot,
  waiting: ShieldAlert,
  pending: CircleDashed
};

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function ToolStatusIcon({ status, Icon }: { status: ToolStatus; Icon: LucideIcon }) {
  const Glyph = status === "complete" ? Icon : STATUS_ICON[status];
  const label = STATUS_LABEL[status];
  return (
    <span className={`tool-state ${status}`} role="img" aria-label={label} title={label}>
      <Glyph size={13} strokeWidth={status === "error" ? 2.5 : 2} aria-hidden="true" />
    </span>
  );
}

export function ToolRow({
  status,
  Icon,
  verb,
  open,
  onToggle,
  controls,
  duration,
  trailing,
  children
}: {
  status: ToolStatus;
  Icon: LucideIcon;
  verb: string;
  open: boolean;
  onToggle: () => void;
  controls: string;
  duration?: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="tool-line">
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <ToolStatusIcon status={status} Icon={Icon} />
        <span className="tool-verb">{verb}</span>
        {children}
        <span className={`tool-caret collapse-caret${open ? " open" : ""}`} aria-hidden="true">
          <ChevronRight size={13} />
        </span>
        {duration !== undefined && <span className="tool-dur">{duration}</span>}
      </button>
      {trailing}
    </div>
  );
}

function useApprovalWait(sessionId: string | undefined, toolName: string, running: boolean): boolean {
  return useAppStore((s) => {
    if (!running || sessionId === undefined) return false;
    const pending = s.pendingApprovals[sessionId];
    if (!pending || pending.length === 0) return false;
    return pending.some((a) => a.toolName !== undefined && a.toolName.toLowerCase() === toolName);
  });
}

export const ToolCard = memo(function ToolCard({
  message,
  basePath,
  sessionId,
  onPreview,
  defaultOpen
}: {
  message: ChatMessage;
  basePath?: string;
  sessionId?: string;
  onPreview?: (path: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const detailId = useId();
  const name = message.toolName ?? "tool";
  const lowerName = name.toLowerCase();
  const isError = message.isError === true;
  const done = message.toolDone === true || message.toolOutput !== undefined;
  const running = message.toolInput !== undefined && !done;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);
  const waiting = useApprovalWait(sessionId, lowerName, running);
  const elapsed = useElapsed(message.toolStartedAt, running);
  const status: ToolStatus = isError ? "error" : waiting ? "waiting" : running ? "running" : done ? "complete" : "pending";
  const toolInput = message.toolInput ?? recoverToolInput(name, message.text);
  const summary = describeToolCall(name, toolInput);
  const fileDiff = extractFileDiff(name, toolInput) ?? extractFileDiffFromText(name, message.text);
  const MAX_DIFF_LINES = 120;
  const visibleDiff = fileDiff?.slice(0, MAX_DIFF_LINES) ?? [];
  const hiddenDiffCount = fileDiff && fileDiff.length > visibleDiff.length ? fileDiff.length - visibleDiff.length : 0;
  const isShell = lowerName === "bash" || lowerName === "shell";
  let subjectUnavailable = false;
  if (summary && !summary.subject) {
    if (isShell) {
      const command = extractCommandFragment(message.text);
      if (command) {
        const flat = command.replace(/\s+/g, " ").trim();
        summary.subject = flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
        summary.subjectKind = "text";
        if (flat.length > 90) summary.fullSubject = command;
      }
    } else {
      const file = extractFileFragment(message.text);
      if (file) {
        summary.subject = file;
        summary.subjectKind = "file";
      }
    }
  }
  if (summary && !summary.subject) {
    const rawDetail = stripToolNamePrefix(name, message.text).trim();
    const hasDetail = Boolean(rawDetail) && rawDetail.toLowerCase() !== lowerName;
    subjectUnavailable = !hasDetail;
    summary.subject = hasDetail
      ? (rawDetail.length > 90 ? `${rawDetail.slice(0, 89)}…` : rawDetail)
      : isShell
        ? "command details unavailable"
        : "target details unavailable";
    summary.subjectKind = "text";
  }
  const homeDir = useAppStore((s) => s.homeDir);
  const home = homeDir ?? undefined;
  const formatText = (value: string): string =>
    shortenHomeInText(basePath ? relativizeInText(basePath, value) : value, home);
  const isTodo = lowerName === "todowrite" || lowerName === "todo";
  const todoRaw = (isTodo ? toolInput : undefined) as Record<string, unknown> | undefined;
  const todoItems = isTodo
    ? (Array.isArray(todoRaw?.["todos"]) ? (todoRaw?.["todos"] as Array<Record<string, unknown>>) : [])
        .map((t) => ({
          status: String(t["status"] ?? "pending"),
          content: String(t["content"] ?? t["label"] ?? "")
        }))
        .filter((t) => t.content)
    : [];
  if (isTodo && todoItems.length > 0) {
    return (
      <div className="worklog">
        {todoItems.map((t, i) => (
          <div key={`${i}-${t.content}`} className="worklog-row">
            <span
              className={`worklog-dot ${t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending"}`}
            >
              {t.status === "completed" && <Check size={10} strokeWidth={3.5} aria-hidden="true" />}
            </span>
            <span className="worklog-label" title={t.content}>
              {t.content}
            </span>
          </div>
        ))}
      </div>
    );
  }
  const displaySubject =
    summary?.subject && (summary.subjectKind === "file" || looksLikeFileMention(summary.subject))
      ? formatFileSubject(summary.subject, basePath, home)
      : summary?.subject && summary.subjectKind !== "file" && isShell
        ? formatText(summary.subject)
        : summary?.subject;
  const previewPath = summary?.subject ? stripMentionMarker(summary.subject) : undefined;
  const output = (message.toolOutput ?? "").slice(0, 2000);
  const spanMs = done ? toolSpanMs([message]) : undefined;
  const duration =
    status === "waiting"
      ? "needs approval"
      : running
        ? message.toolStartedAt !== undefined
          ? formatDuration(elapsed)
          : "running"
        : spanMs !== undefined
          ? formatToolDuration(spanMs)
          : undefined;
  const command = isShell && summary && !subjectUnavailable ? (summary.fullSubject ?? summary.subject) : undefined;
  const canPreview =
    summary?.subject !== undefined &&
    summary.subjectKind === "file" &&
    previewPath !== undefined &&
    isPreviewablePath(previewPath) &&
    sessionId !== undefined &&
    onPreview !== undefined;

  let subject: ReactNode;
  if (!summary) {
    const firstLine = (stripToolNamePrefix(name, message.text).split("\n")[0] ?? "").slice(0, 120) || "…";
    subject = !open && <span className="tool-subject">{firstLine}</span>;
  } else {
    subject = (
      <>
        {summary.subject && summary.subjectKind === "file" && (
          <span className="tool-subject file" title={summary.subject}>
            <FileIcon name={baseName(displaySubject ?? summary.subject)} size={12} />
            <span className="tool-subject-text">{displaySubject}</span>
          </span>
        )}
        {summary.subject && summary.subjectKind !== "file" && (
          <span className="tool-subject" title={summary.subject}>
            {open ? summary.subject : (displaySubject ?? summary.subject)}
          </span>
        )}
        {summary.stat && (
          <span className="tool-stat">
            <span className="add">+{summary.stat.added}</span> <span className="del">−{summary.stat.removed}</span>
          </span>
        )}
        {!summary.stat && summary.meta?.filter((m) => /^\d+\s+(?:files|lines)$/.test(m)).map((m) => (
          <span key={m} className="tool-stat">
            {m}
          </span>
        ))}
      </>
    );
  }

  return (
    <div className={`tool-card ${status}${open ? " open" : ""}`}>
      <ToolRow
        status={status}
        Icon={summary?.Icon ?? Wrench}
        verb={summary?.verb ?? name}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={detailId}
        duration={duration}
        trailing={
          canPreview && (
            <button
              type="button"
              className="icon-btn tool-side-btn"
              title="Preview rendered file"
              aria-label="Preview rendered file"
              onClick={() => onPreview(previewPath)}
            >
              <Monitor size={13} />
            </button>
          )
        }
      >
        {subject}
      </ToolRow>
      {open && (
        <div id={detailId} className="tool-detail">
          {summary?.fullSubject && !command && <div className="tool-meta">{formatText(summary.fullSubject)}</div>}
          {summary?.meta?.map((m) => (
            <div key={m} className="tool-meta">
              {formatText(m)}
            </div>
          ))}
          {command && (
            <div className="tool-cmd">
              <span className="tool-cmd-prompt" aria-hidden="true">$</span>
              <span className="tool-cmd-text">{formatText(command)}</span>
            </div>
          )}
          {!summary && <pre className="tool-output">{message.text}</pre>}
          {summary && running && (
            <div className="tool-pending">
              <span className="pulse" /> {status === "waiting" ? "Waiting for approval…" : "Running…"}
            </div>
          )}
          {visibleDiff.length > 0 && (
            <>
              <div className="tool-output-label">diff</div>
              <div className="diff-body tool-diff">
                {visibleDiff.map((line, i) => (
                  <div key={i} className={`diff-line ${line.type}`}>
                    <span className="diff-gutter">{line.type === "add" ? "+" : "−"}</span>
                    <span className="diff-text">{line.text || " "}</span>
                  </div>
                ))}
              </div>
              {hiddenDiffCount > 0 && <div className="tool-meta">… {hiddenDiffCount} more lines</div>}
            </>
          )}
          {summary && done && output && (
            <>
              <div className={`tool-output-label${isError ? " error" : ""}`}>{isError ? "error" : "output"}</div>
              <pre className="tool-output">{output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
