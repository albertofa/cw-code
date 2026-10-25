import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../stores/appStore.js";
import { describeToolCall, formatDuration, isRunningTool, relativizeToBase } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";
import { runningTurnId, useThreadBusy, useThreadEntry, useThreadItemsSelect } from "./useThread.js";

function runningStep(messages: ChatMessage[], turnId: string, basePath: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.turnId !== undefined && m.turnId !== turnId) return undefined;
    if (m.role !== "tool" || !isRunningTool(m)) continue;
    const name = m.toolName ?? "tool";
    const summary = describeToolCall(name, m.toolInput);
    if (!summary) return name;
    if (!summary.subject) return summary.verb;
    const subject =
      summary.subjectKind === "file" && basePath ? relativizeToBase(basePath, summary.subject) : summary.subject;
    return `${summary.verb} ${subject}`;
  }
  return undefined;
}

function WorkingElapsed({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt, true);
  return <span className="working-dock-time">{formatDuration(elapsed)}</span>;
}

export function WorkingDock({ sessionId, basePath }: { sessionId: string; basePath: string }) {
  const turn = useThreadEntry(sessionId, "turn");
  const approvals = useThreadEntry(sessionId, "approvals");
  const questions = useThreadEntry(sessionId, "questions");
  const startedAt = turn?.startedAt;
  const waiting =
    (approvals?.length ?? 0) > 0 ? "waiting for approval" : (questions?.length ?? 0) > 0 ? "waiting for your answer" : undefined;
  const step = useThreadItemsSelect(sessionId, (items) => {
    const turnId = runningTurnId(turn, items);
    return turnId === undefined ? undefined : runningStep(items, turnId, basePath);
  });
  const running = useThreadBusy(sessionId);
  const [announcement, setAnnouncement] = useState("");
  const wasRunning = useRef(running);

  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    setAnnouncement(running ? "Working" : "Turn finished");
  }, [running]);

  const detail = waiting ?? step;

  return (
    <>
      <div className="working-dock-announce" role="status" aria-live="polite">
        {announcement}
      </div>
      {running && (
        <section className="working-dock" aria-label="Turn status">
          <div className="working-dock-row" title={detail ? `Working · ${detail}` : "Working"}>
            <span className="pulse" aria-hidden="true" />
            <span className="working-dock-label">Working</span>
            {detail && <span className="working-dock-step">{detail}</span>}
            {startedAt !== undefined && <WorkingElapsed startedAt={startedAt} />}
          </div>
        </section>
      )}
    </>
  );
}
