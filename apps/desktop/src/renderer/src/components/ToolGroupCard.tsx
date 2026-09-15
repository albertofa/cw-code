import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Circle, CircleDot, TriangleAlert } from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";
import { summarizeToolGroup } from "./toolSummaries.js";
import { ToolCard } from "./ToolCard.js";

function GroupState({ status }: { status: "complete" | "error" | "running" | "pending" }) {
  if (status === "complete") return <span className="tool-state" aria-hidden="true" />;
  const label = status === "error" ? "Error" : status === "running" ? "Running" : "Pending";
  const Icon = status === "error" ? TriangleAlert : status === "running" ? CircleDot : Circle;
  return (
    <span className={`tool-state ${status}`} role="img" aria-label={label} title={label}>
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}

function isRunning(m: ChatMessage): boolean {
  const done = m.toolDone === true || m.toolOutput !== undefined;
  return m.toolInput !== undefined && !done;
}

export const ToolGroupCard = memo(function ToolGroupCard({
  messages,
  basePath,
  sessionId,
  onPreview
}: {
  messages: ChatMessage[];
  basePath?: string;
  sessionId?: string;
  onPreview?: (path: string) => void;
}) {
  const summary = summarizeToolGroup(messages);
  const hasRunning = summary?.hasRunning ?? messages.some(isRunning);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const prevRunning = useRef(hasRunning);
  useEffect(() => {
    if (prevRunning.current !== hasRunning) {
      prevRunning.current = hasRunning;
      setManualOpen(null);
    }
  }, [hasRunning]);
  const open = manualOpen ?? hasRunning;
  if (!summary) return null;
  const TypeIcon = summary.Icon;
  const statusLabel = summary.status === "complete" ? "Completed" : summary.status === "error" ? "Error" : summary.status === "running" ? "Running" : "Pending";

  return (
    <div
      className={`tool-group${summary.status === "running" ? " running" : ""}${summary.status === "error" ? " error" : ""}`}
      title={open ? "Collapse" : "Expand"}
    >
      <div
        className="tool-head"
        onClick={() => setManualOpen(!open)}
        role="button"
        aria-expanded={open}
        aria-label={`${summary.text} — ${statusLabel}`}
      >
        <GroupState status={summary.status} />
        <span className="tool-group-icon" aria-hidden="true">
          <TypeIcon size={13} />
        </span>
        <span className="tool-action tool-group-text">{summary.text}</span>
        <span className="tool-caret" aria-hidden="true">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </div>
      {open && (
        <div className="tool-group-items">
          {messages.map((m) => (
            <ToolCard
              key={m.id}
              message={m}
              basePath={basePath}
              sessionId={sessionId}
              onPreview={onPreview}
              defaultOpen={isRunning(m) || m.isError === true}
            />
          ))}
        </div>
      )}
    </div>
  );
});
