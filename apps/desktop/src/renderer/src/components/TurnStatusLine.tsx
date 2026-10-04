import { useEffect, useRef, useState } from "react";
import { useAppStore, type ChatMessage } from "../stores/appStore.js";
import { describeToolCall, formatDuration, isRunningTool, relativizeToBase } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";

const NO_MESSAGES: ChatMessage[] = [];

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

export function TurnStatusLine({ sessionId, basePath }: { sessionId: string; basePath: string }) {
  const turnId = useAppStore((s) => s.busyTurns[sessionId]);
  const startedAt = useAppStore((s) => s.turnStartedAt[sessionId]);
  const waiting = useAppStore((s) =>
    (s.pendingApprovals[sessionId]?.length ?? 0) > 0
      ? "waiting for approval"
      : (s.pendingQuestions[sessionId]?.length ?? 0) > 0
        ? "waiting for your answer"
        : undefined
  );
  const step = useAppStore((s) =>
    turnId === undefined ? undefined : runningStep(s.messagesBySession[sessionId] ?? NO_MESSAGES, turnId, basePath)
  );
  const running = turnId !== undefined;
  const elapsed = useElapsed(startedAt, running);
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
      <div className="turn-status-announce" role="status" aria-live="polite">
        {announcement}
      </div>
      {running && (
        <div className="turn-status">
          <span className="pulse" aria-hidden="true" />
          <span className="turn-status-label">Working</span>
          {startedAt !== undefined && <span className="turn-status-time">{formatDuration(elapsed)}</span>}
          {detail && (
            <>
              <span className="turn-status-sep" aria-hidden="true">·</span>
              <span className="turn-status-step" title={detail}>
                {detail}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
