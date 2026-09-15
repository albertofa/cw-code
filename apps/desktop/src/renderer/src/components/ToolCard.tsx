import { memo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, Monitor, TriangleAlert } from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";
import {
  describeToolCall,
  extractCommandFragment,
  extractFileFragment,
  recoverToolInput,
  relativizeInText,
  relativizeToBase,
  stripToolNamePrefix
} from "./toolSummaries.js";
import { FileIcon } from "./fileIcons.js";
import { isPreviewablePath } from "./Markdown.js";

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function LegacyHead({ name, text, open }: { name: string; text: string; open: boolean }) {
  const firstLine = (text.split("\n")[0] ?? "").slice(0, 120) || "…";
  return (
    <>
      <span className="tool-action">{name}</span>
      {!open && <span className="tool-subject">{firstLine}</span>}
    </>
  );
}

function ToolState({ state }: { state: "complete" | "error" | "running" | "pending" }) {
  if (state === "complete") return <span className="tool-state" aria-hidden="true" />;
  const label = state === "error" ? "Error" : state === "running" ? "Running" : "Pending";
  const Icon = state === "error" ? TriangleAlert : state === "running" ? CircleDot : Circle;
  return (
    <span className={`tool-state ${state}`} role="img" aria-label={label} title={label}>
      <Icon size={13} aria-hidden="true" />
    </span>
  );
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
  const name = message.toolName ?? "tool";
  const isError = message.isError === true;
  const done = message.toolDone === true || message.toolOutput !== undefined;
  const running = message.toolInput !== undefined && !done;
  const state = isError ? "error" : running ? "running" : done ? "complete" : "pending";
  const summary = describeToolCall(name, message.toolInput ?? recoverToolInput(name, message.text));
  if (summary && !summary.subject) {
    if (name.toLowerCase() === "bash" || name.toLowerCase() === "shell") {
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
    summary.subject = rawDetail && rawDetail.toLowerCase() !== name.toLowerCase()
      ? (rawDetail.length > 90 ? `${rawDetail.slice(0, 89)}…` : rawDetail)
      : name.toLowerCase() === "bash" || name.toLowerCase() === "shell"
        ? "command details unavailable"
        : "target details unavailable";
    summary.subjectKind = "text";
  }
  const lowerName = name.toLowerCase();
  const isShell = lowerName === "bash" || lowerName === "shell";
  const isTodo = lowerName === "todowrite" || lowerName === "todo";
  const todoRaw = (isTodo ? message.toolInput ?? recoverToolInput(name, message.text) : undefined) as
    | Record<string, unknown>
    | undefined;
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
              {t.status === "completed" && <Check size={11} strokeWidth={3.5} aria-hidden="true" />}
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
    summary?.subject && summary.subjectKind === "file" && basePath
      ? relativizeToBase(basePath, summary.subject)
      : summary?.subject && summary.subjectKind !== "file" && isShell && basePath
        ? relativizeInText(basePath, summary.subject)
        : summary?.subject;
  const output = (message.toolOutput ?? "").slice(0, 2000);

  let head: ReactNode;
  if (summary) {
    head = (
      <>
        <span className="tool-action">{summary.verb}</span>
        {summary.subject && summary.subjectKind === "file" && (
          <span className="tool-subject file" title={summary.subject}>
            <FileIcon name={baseName(displaySubject ?? summary.subject)} size={13} />
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
        {summary.subject &&
          summary.subjectKind === "file" &&
          isPreviewablePath(summary.subject) &&
          sessionId &&
          onPreview && (
            <button
              className="icon-btn tool-preview-btn"
              title="Preview rendered file"
              aria-label="Preview rendered file"
              onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                onPreview(summary.subject as string);
              }}
            >
              <Monitor size={13} />
            </button>
          )}
      </>
    );
  } else {
    head = <LegacyHead name={name} text={stripToolNamePrefix(name, message.text)} open={open} />;
  }

  return (
    <div
      className={`tool-card${isError ? " error" : ""}${running ? " running" : ""}`}
      onClick={() => setOpen((o) => !o)}
      title={open ? "Collapse" : "Expand"}
    >
      <div className="tool-head">
        <ToolState state={state} />
        {head}
        <span className="tool-caret" aria-hidden="true">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </div>
      {open && (
        <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
          {summary?.fullSubject && (
            <div className="tool-meta">
              {basePath ? relativizeInText(basePath, summary.fullSubject) : summary.fullSubject}
            </div>
          )}
          {summary?.meta?.map((m) => (
            <div key={m} className="tool-meta">
              {basePath ? relativizeInText(basePath, m) : m}
            </div>
          ))}
          {!summary && <pre className="tool-output">{message.text}</pre>}
          {summary && running && (
            <div className="tool-pending">
              <span className="pulse" /> Running…
            </div>
          )}
          {summary && done && output && (
            <>
              <div className="tool-output-label">{isError ? "error" : "output"}</div>
              <pre className="tool-output">{output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
