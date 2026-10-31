import { memo, useId, useMemo, useState } from "react";
import { Bot, ChevronRight, PanelRight } from "lucide-react";
import type { SubagentSummary } from "@cw-code/contracts";
import type { ChatMessage } from "../stores/appStore.js";
import { openCwSubagent } from "./AgentsPanel.js";
import { ToolRow, type ToolStatus } from "./ToolCard.js";
import { formatDuration, formatToolDuration, toolSpanMs } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";
import { useThreadEntry } from "./useThread.js";
import {
  cwSubagentState,
  describeCwSubagentCall,
  matchCwSubagent,
  resultTextFor,
  summaryState,
  type CwSubagentCardTool,
  type CwSubagentState
} from "./cwSubagents.js";
import { HarnessTag, PendingBadge, StopSubagentButton, SubagentExcerpt, cwSubagentStateLabel, isActiveState } from "./CwSubagentParts.js";

const NO_SUBAGENTS: SubagentSummary[] = [];
const TITLE_MAX = 90;

const TOOL_STATUS: Record<CwSubagentState, ToolStatus> = {
  running: "running",
  waiting: "waiting",
  completed: "complete",
  failed: "error",
  stopped: "stopped",
  interrupted: "interrupted",
  unknown: "unknown"
};

const VERB: Record<CwSubagentCardTool, string> = {
  subagent_run: "Subagent",
  subagent_send: "Follow-up",
  subagent_wait: "Wait"
};

const PROMPT_LABEL: Record<CwSubagentCardTool, string> = {
  subagent_run: "task",
  subagent_send: "message",
  subagent_wait: "task"
};

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

export const CwSubagentCard = memo(function CwSubagentCard({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const subagents = useThreadEntry(sessionId, "subagents") ?? NO_SUBAGENTS;
  const done = message.toolDone === true || message.toolOutput !== undefined;
  const toolRunning = message.toolInput !== undefined && !done;
  const elapsed = useElapsed(message.toolStartedAt, toolRunning);
  const call = useMemo(
    () => describeCwSubagentCall(message.toolName, message.toolInput, message.toolOutput),
    [message.toolName, message.toolInput, message.toolOutput]
  );
  if (!call) return null;

  const startedAt = message.toolStartedAt ?? message.timestamp;
  const summary = matchCwSubagent(subagents, call, startedAt);
  const subagentId = summary?.id ?? call.subagentId;
  const failedCall = message.isError === true;
  const state: CwSubagentState = failedCall
    ? "failed"
    : summary
      ? summaryState(summary)
      : toolRunning
        ? "running"
        : cwSubagentState(call.output?.status);
  const driver = summary?.driver ?? call.driver;
  const title = summary?.title ?? call.title ?? (call.prompt ? clip(call.prompt) : "Subagent");
  const model = summary?.model ?? call.model;
  const result = failedCall ? (message.toolOutput ?? null) : resultTextFor(call, summary, startedAt);
  const spanMs = done ? toolSpanMs([message]) : undefined;
  const duration = toolRunning
    ? message.toolStartedAt !== undefined
      ? formatDuration(elapsed)
      : "running"
    : spanMs !== undefined
      ? formatToolDuration(spanMs)
      : undefined;
  const openInPanel = () => {
    if (subagentId) openCwSubagent(subagentId);
  };

  return (
    <div className={`tool-card suba-row cw-suba-card ${TOOL_STATUS[state]}${open ? " open" : ""}`}>
      <ToolRow
        status={TOOL_STATUS[state]}
        Icon={Bot}
        verb={VERB[call.tool]}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        controls={panelId}
        duration={duration}
        trailing={
          subagentId && (
            <>
              {summary && isActiveState(state) && <StopSubagentButton subagentId={subagentId} />}
              <button type="button" className="icon-btn tool-side-btn" title="Open in Agents panel" aria-label="Open in Agents panel" onClick={openInPanel}>
                <PanelRight size={13} aria-hidden="true" />
              </button>
            </>
          )
        }
      >
        {driver && <HarnessTag driver={driver} />}
        <span className="tool-subject suba-subject" title={title}>
          {title}
        </span>
        <PendingBadge summary={summary} />
      </ToolRow>
      {open && (
        <div id={panelId} className="suba-panel">
          <div className="suba-panel-head">
            <span className={`suba-panel-state ${state}`}>{cwSubagentStateLabel(state)}</span>
            {model && <span className="suba-badge model">{model}</span>}
            {summary?.isolation === "worktree" && <span className="suba-badge">own worktree</span>}
            {call.output?.timedOut && <span className="suba-badge">wait timed out</span>}
            {subagentId && (
              <button type="button" className="suba-view" onClick={openInPanel}>
                Open
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          {call.prompt && <SubagentExcerpt text={call.prompt} label={PROMPT_LABEL[call.tool]} />}
          {result && <SubagentExcerpt text={result} label={state === "failed" ? "error" : "result"} error={state === "failed"} />}
          {!result && isActiveState(state) && <div className="suba-empty">No result yet.</div>}
        </div>
      )}
    </div>
  );
});
