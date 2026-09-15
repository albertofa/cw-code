import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import type { ChatMessage } from "../stores/appStore.js";
import { formatDuration } from "./toolSummaries.js";

export const ReasoningBlock = memo(function ReasoningBlock({
  message,
  live
}: {
  message: ChatMessage;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ms = message.reasoningMs;
  const label = live
    ? "Thinking…"
    : ms !== undefined && ms >= 1000
      ? `Thought for ${formatDuration(ms)}`
      : "Thought";
  return (
    <div
      className={`reasoning${live ? " reasoning-live" : ""}`}
      onClick={() => setOpen((o) => !o)}
      title={open ? "Collapse" : "Expand"}
    >
      <div className="reasoning-head">
        <Brain size={13} className="reasoning-icon" aria-hidden="true" />
        <span className="reasoning-label">{label}</span>
        <span className="reasoning-caret" aria-hidden="true">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>
      {open && <div className="reasoning-text">{message.text}</div>}
    </div>
  );
});
