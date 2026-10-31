import { Bot, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DriverKind } from "@cw-code/contracts";
import type { ChatMessage } from "../stores/appStore.js";
import { backgroundWaitLabel, cwSubagentWork, liveBackgroundWork, sameBackgroundWork, type BackgroundWork } from "./backgroundWork.js";
import { describeToolCall, formatDuration, isRunningTool, relativizeToBase } from "./toolSummaries.js";
import { useElapsed } from "./useElapsed.js";
import { runningTurnId, useThreadBusy, useThreadEntry, useThreadItemsSelect } from "./useThread.js";

function runningStep(messages: ChatMessage[], turnId: string, basePath: string, sessionDriver: DriverKind): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.turnId !== undefined && m.turnId !== turnId) return undefined;
    if (m.role !== "tool" || !isRunningTool(m)) continue;
    const name = m.toolName ?? "tool";
    const summary = describeToolCall(name, m.toolInput, sessionDriver);
    if (!summary) return name;
    if (!summary.subject) return summary.verb;
    const subject =
      summary.subjectKind === "file" && basePath ? relativizeToBase(basePath, summary.subject) : summary.subject;
    const commandCount =
      summary.commandCount !== undefined && summary.commandCount > 1
        ? ` · ${summary.commandCount} commands`
        : "";
    return `${summary.verb}${commandCount} ${subject}`;
  }
  return undefined;
}

function WorkingElapsed({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt, true);
  return <span className="working-dock-time">{formatDuration(elapsed)}</span>;
}

const MAX_BACKGROUND_ROWS = 3;

function BackgroundRows({ work }: { work: BackgroundWork[] }) {
  const shown = work.slice(0, MAX_BACKGROUND_ROWS);
  const hidden = work.length - shown.length;
  return (
    <ul className="working-dock-background" aria-label="Background work">
      {shown.map((w) => {
        const Icon = w.kind === "agent" ? Bot : Terminal;
        return (
          <li key={w.id} className="working-dock-row working-dock-bg-row" title={w.detail ? `${w.label}\n${w.detail}` : w.label}>
            <Icon className="working-dock-bg-icon" size={12} aria-hidden="true" />
            <span className="working-dock-step">{w.label}</span>
            {w.startedAt !== undefined && <WorkingElapsed startedAt={w.startedAt} />}
          </li>
        );
      })}
      {hidden > 0 && <li className="working-dock-row working-dock-bg-row working-dock-bg-more">+{hidden} more</li>}
    </ul>
  );
}

export function WorkingDock({ sessionId, sessionDriver, basePath }: { sessionId: string; sessionDriver: DriverKind; basePath: string }) {
  const turn = useThreadEntry(sessionId, "turn");
  const approvals = useThreadEntry(sessionId, "approvals");
  const questions = useThreadEntry(sessionId, "questions");
  const subagentWait = useThreadEntry(sessionId, "subagentWait");
  const subagents = useThreadEntry(sessionId, "subagents");
  const startedAt = turn?.startedAt ?? subagentWait?.since;
  const waiting =
    (approvals?.length ?? 0) > 0 ? "waiting for approval" : (questions?.length ?? 0) > 0 ? "waiting for your answer" : undefined;
  const step = useThreadItemsSelect(sessionId, (items) => {
    const turnId = runningTurnId(turn, items);
    return turnId === undefined ? undefined : runningStep(items, turnId, basePath, sessionDriver);
  });
  const native = useThreadItemsSelect(sessionId, liveBackgroundWork, sameBackgroundWork);
  const background = useMemo(
    () => (turn == null && subagentWait != null && subagents ? [...native, ...cwSubagentWork(subagents)] : native),
    [native, turn, subagentWait, subagents]
  );
  const running = useThreadBusy(sessionId);
  const [announcement, setAnnouncement] = useState("");
  const wasRunning = useRef(running);

  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    setAnnouncement(running ? "Working" : "Turn finished");
  }, [running]);

  const detail = waiting ?? step ?? backgroundWaitLabel(background);

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
          {background.length > 0 && <BackgroundRows work={background} />}
        </section>
      )}
    </>
  );
}
