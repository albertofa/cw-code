import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Circle, CircleDot, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";
import { summarizeToolGroup } from "./toolSummaries.js";
import { ToolCard } from "./ToolCard.js";

function GroupState({ status, Icon }: { status: "complete" | "error" | "running" | "pending"; Icon: LucideIcon }) {
  if (status === "complete") {
    return (
      <span className="tool-state complete" aria-hidden="true">
        <Icon size={13} />
      </span>
    );
  }
  const label = status === "error" ? "Error" : status === "running" ? "Running" : "Pending";
  const StateIcon = status === "error" ? TriangleAlert : status === "running" ? CircleDot : Circle;
  return (
    <span className={`tool-state ${status}`} role="img" aria-label={label} title={label}>
      <StateIcon size={13} aria-hidden="true" />
    </span>
  );
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
  const [open, setOpen] = useState(false);
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
        onClick={() => setOpen(!open)}
        role="button"
        aria-expanded={open}
        aria-label={`${summary.text} — ${statusLabel}`}
      >
        <GroupState status={summary.status} Icon={TypeIcon} />
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
              defaultOpen={m.isError === true}
            />
          ))}
        </div>
      )}
    </div>
  );
});
