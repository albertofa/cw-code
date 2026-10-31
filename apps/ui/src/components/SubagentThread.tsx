import { useMemo } from "react";
import { ChevronLeft, Sparkles, Square, TriangleAlert } from "lucide-react";
import type { SubagentSummary } from "@cw-code/contracts";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { findSession } from "../server/sidebarData.js";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { DriverIcon } from "./DriverIcon.js";
import { Md, StreamingMd } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { ToolCard } from "./ToolCard.js";
import { useNotifs } from "./Notifications.js";
import { ipcErrorMessage } from "./ipcError.js";
import { orderToolsForDisplay } from "./toolSummaries.js";
import { summaryState } from "./cwSubagents.js";
import { HarnessTag, PendingBadge, StateDot, cwSubagentStateLabel, isActiveState, stopCwSubagent } from "./CwSubagentParts.js";
import { runningTurnId, useThreadEntry, useThreadItems, useThreadTopicError } from "./useThread.js";

function reloadChildHistory(sessionId: string): void {
  void window.cw.reloadHistory(sessionId).catch((err: unknown) => {
    useNotifs.getState().push({ kind: "error", title: "Could not load history", message: ipcErrorMessage(err) });
  });
}

function useChildBasePath(sessionId: string): string | undefined {
  return useAppStore((s) => {
    const session = findSession(s.sessionsByProject, sessionId);
    if (!session) return undefined;
    return session.worktreePath ?? s.projects.find((p) => p.id === session.projectId)?.rootPath;
  });
}

function ChildItem({
  item,
  sessionId,
  basePath,
  busyTurn,
  streaming
}: {
  item: ChatMessage;
  sessionId: string;
  basePath: string | undefined;
  busyTurn: string | undefined;
  streaming: boolean;
}) {
  if (item.role === "user") {
    return (
      <div className="msg-user-wrap">
        <div className="msg-user">{item.text}</div>
      </div>
    );
  }
  if (item.role === "tool") return <ToolCard message={item} basePath={basePath} sessionId={sessionId} />;
  if (item.role === "reasoning") {
    return <ReasoningBlock message={item} live={busyTurn === item.turnId && item.reasoningMs === undefined} />;
  }
  if (item.role === "system") {
    return (
      <div className={`msg-system${item.severity === "warning" ? " msg-warning" : ""}`}>
        <TriangleAlert size={14} aria-hidden="true" />
        <span>{item.text}</span>
      </div>
    );
  }
  return <div className="msg-assistant">{streaming ? <StreamingMd text={item.text} /> : <Md text={item.text} />}</div>;
}

export function SubagentThread({ summary, onBack }: { summary: SubagentSummary; onBack: () => void }) {
  const items = useThreadItems(summary.id);
  const turn = useThreadEntry(summary.id, "turn");
  const history = useThreadEntry(summary.id, "history");
  const topicError = useThreadTopicError(summary.id);
  const basePath = useChildBasePath(summary.id);
  const busyTurn = runningTurnId(turn, items);
  const state = summaryState(summary);
  const shown = useMemo(() => orderToolsForDisplay(items).filter((item) => !item.parentToolCallId), [items]);
  const streamingId = useMemo(() => {
    if (!busyTurn) return null;
    for (let i = shown.length - 1; i >= 0; i--) {
      if (shown[i].role === "assistant" && shown[i].turnId === busyTurn) return shown[i].id;
    }
    return null;
  }, [shown, busyTurn]);
  const historyError = history?.state === "error" ? (history.error ?? "unknown error") : topicError;
  const loading = !historyError && history?.state !== "loaded";

  return (
    <div className="agents-detail">
      <div className="agents-backrow">
        <button className="agents-back" type="button" onClick={onBack}>
          <ChevronLeft aria-hidden="true" size={14} />
          All subagents
        </button>
        <span className="agents-crumb">cw subagent</span>
      </div>

      <div className="agents-hero">
        <div className="agents-hero-top">
          <span className="agents-hero-badge">
            <DriverIcon driver={summary.driver} size={16} />
          </span>
          <h3 className="agents-hero-name" title={summary.title}>
            {summary.title}
          </h3>
        </div>
        <div className="agents-hero-chips">
          <HarnessTag driver={summary.driver} />
          {summary.model && <span className="suba-badge model">{summary.model}</span>}
          {summary.isolation === "worktree" && <span className="suba-badge">own worktree</span>}
          <PendingBadge summary={summary} />
          <span className={`agents-hero-state ${state}`}>
            <StateDot state={state} />
            {cwSubagentStateLabel(state)}
          </span>
        </div>
        {isActiveState(state) && (
          <div className="agents-actions">
            <button className="btn" type="button" onClick={() => stopCwSubagent(summary.id)}>
              <Square aria-hidden="true" size={13} />
              Stop
            </button>
          </div>
        )}
      </div>

      <div className="cw-suba-docks">
        <ApprovalDock sessionId={summary.id} />
        <QuestionDock sessionId={summary.id} />
      </div>

      <section className="agents-section cw-suba-thread" aria-label="Subagent thread">
        {loading && shown.length === 0 && (
          <div className="agents-section-empty">
            <Sparkles aria-hidden="true" size={14} /> Loading thread…
          </div>
        )}
        {!loading && historyError && shown.length === 0 && (
          <div className="agents-section-empty">
            Could not load the thread: {historyError}{" "}
            <button className="agents-more" type="button" onClick={() => reloadChildHistory(summary.id)}>
              Retry
            </button>
          </div>
        )}
        {!loading && !historyError && shown.length === 0 && <div className="agents-section-empty">No messages yet.</div>}
        {shown.map((item) => (
          <ChildItem
            key={item.id}
            item={item}
            sessionId={summary.id}
            basePath={basePath}
            busyTurn={busyTurn}
            streaming={item.id === streamingId}
          />
        ))}
      </section>
    </div>
  );
}
