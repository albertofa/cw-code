import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Monitor, Wrench } from "lucide-react";
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
      <Wrench size={13} className="tool-icon" />
      <span className="tool-action">{name}</span>
      {!open && <span className="tool-subject">{firstLine}</span>}
    </>
  );
}

export function ToolCard({
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
  const lowerName = name.toLowerCase();
  const isShell = lowerName === "bash" || lowerName === "shell";
  const displaySubject =
    summary?.subject && summary.subjectKind === "file" && basePath
      ? relativizeToBase(basePath, summary.subject)
      : summary?.subject && summary.subjectKind !== "file" && isShell && basePath
        ? relativizeInText(basePath, summary.subject)
        : summary?.subject;
  const output = (message.toolOutput ?? "").slice(0, 2000);

  let head: ReactNode;
  if (summary) {
    const Icon = summary.Icon;
    head = (
      <>
        <Icon size={13} className="tool-icon" />
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
        {head}
        {running && <span className="pulse" title="Running" />}
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
          {summary?.fullSubject && <div className="tool-meta">{summary.fullSubject}</div>}
          {summary?.meta?.map((m) => (
            <div key={m} className="tool-meta">
              {m}
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
}
