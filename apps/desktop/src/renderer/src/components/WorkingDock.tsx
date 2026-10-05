import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
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

function WorkingElapsed({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt, true);
  return <span className="working-dock-time">{formatDuration(elapsed)}</span>;
}

export function WorkingDock({ sessionId, basePath }: { sessionId: string; basePath: string }) {
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
            {startedAt !== undefined && <WorkingElapsed startedAt={startedAt} />}
            {detail && <span className="working-dock-step">{detail}</span>}
            <button
              type="button"
              className="working-dock-stop"
              onClick={() => void useAppStore.getState().interrupt()}
              title="Stop the turn"
              aria-label="Stop the turn"
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
              <span className="working-dock-stop-label">Stop</span>
            </button>
          </div>
        </section>
      )}
    </>
  );
}
