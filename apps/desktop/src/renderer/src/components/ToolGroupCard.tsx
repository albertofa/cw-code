import { memo, useId, useState } from "react";
import type { ChatMessage } from "../stores/appStore.js";
import { formatToolDuration, summarizeToolGroup, toolSpanMs } from "./toolSummaries.js";
import { ToolCard, ToolRow } from "./ToolCard.js";

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
  const itemsId = useId();
  if (!summary) return null;
  const space = summary.text.indexOf(" ");
  const verb = space > 0 ? summary.text.slice(0, space) : summary.text;
  const rest = space > 0 ? summary.text.slice(space + 1) : "";
  const spanMs = summary.hasRunning ? undefined : toolSpanMs(messages);

  return (
    <div className={`tool-group ${summary.status}${open ? " open" : ""}`}>
      <ToolRow
        status={summary.status}
        verb={verb}
        open={open}
        onToggle={() => setOpen(!open)}
        controls={itemsId}
        duration={spanMs !== undefined ? formatToolDuration(spanMs) : undefined}
      >
        {rest && <span className="tool-group-text">{rest}</span>}
      </ToolRow>
      {open && (
        <div id={itemsId} className="tool-group-items">
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
