import { Fragment, useMemo } from "react";
import { harnessLabel } from "@cw-code/shared/harnessLabels";
import { ApprovalDock } from "./ApprovalDock.js";
import { QuestionDock } from "./QuestionDock.js";
import { hasPendingRequests } from "./cwSubagents.js";
import { useThreadEntry } from "./useThread.js";

export function SubagentRequestDocks({ sessionId }: { sessionId: string }) {
  const subagents = useThreadEntry(sessionId, "subagents");
  const waiting = useMemo(() => (subagents ?? []).filter(hasPendingRequests), [subagents]);
  return (
    <>
      {waiting.map((child) => {
        const origin = `${harnessLabel(child.driver)} subagent · ${child.title}`;
        return (
          <Fragment key={child.id}>
            <ApprovalDock sessionId={child.id} origin={origin} />
            <QuestionDock sessionId={child.id} origin={origin} />
          </Fragment>
        );
      })}
    </>
  );
}
