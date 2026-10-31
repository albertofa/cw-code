import { memo } from "react";
import { Bot, PanelRight } from "lucide-react";
import type { WakeEntry } from "@cw-code/shared/subagents";
import type { ChatMessage } from "../stores/appStore.js";
import { openCwSubagent } from "./AgentsPanel.js";
import { WAKE_OUTCOME_STATE } from "./cwSubagents.js";
import { HarnessTag, StateDot, SubagentExcerpt, cwSubagentStateLabel } from "./CwSubagentParts.js";

function WakeRow({ entry }: { entry: WakeEntry }) {
  const state = WAKE_OUTCOME_STATE[entry.outcome];
  return (
    <div className="suba-results-row">
      <div className="suba-results-line">
        <StateDot state={state} />
        <HarnessTag driver={entry.driver} />
        <span className="suba-results-title" title={entry.title}>
          {entry.title}
        </span>
        <span className={`suba-panel-state ${state}`}>{cwSubagentStateLabel(state)}</span>
        <button
          type="button"
          className="icon-btn tool-side-btn"
          title="Open in Agents panel"
          aria-label={`Open ${entry.title} in Agents panel`}
          onClick={() => openCwSubagent(entry.subagentId)}
        >
          <PanelRight size={13} aria-hidden="true" />
        </button>
      </div>
      {entry.text?.trim() ? (
        <SubagentExcerpt text={entry.text} label={state === "failed" ? "error" : "result"} error={state === "failed"} />
      ) : (
        <div className="suba-empty">No result text.</div>
      )}
    </div>
  );
}

export const SubagentResultsCard = memo(function SubagentResultsCard({ message, entries }: { message: ChatMessage; entries: WakeEntry[] }) {
  const date = message.timestamp === undefined ? undefined : new Date(message.timestamp);
  const validDate = date && Number.isFinite(date.getTime()) ? date : undefined;
  return (
    <section className="suba-results" data-prompt-id={message.id} aria-label="Subagent results">
      <header className="suba-results-head">
        <Bot size={14} aria-hidden="true" />
        <span className="suba-results-heading">Subagent results</span>
        <span className="suba-results-count">{entries.length}</span>
        {validDate && (
          <time dateTime={validDate.toISOString()} title={validDate.toLocaleString()}>
            {validDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </time>
        )}
      </header>
      {entries.map((entry, index) => (
        <WakeRow key={`${entry.subagentId}:${index}`} entry={entry} />
      ))}
    </section>
  );
});
