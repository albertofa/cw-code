import { useCallback, useMemo } from "react";
import type { PrWorkflow, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { babysitState, type BabysitState } from "./prSessionModel.js";
import { prSummaryLookup } from "./sessionPrLinks.js";
import { usePrSettings } from "./useLinkedPr.js";

const NO_WORKFLOWS: PrWorkflow[] = [];

export function useBabysitStates(): (session: Session) => BabysitState | null {
  const busyTurns = useAppStore((s) => s.busyTurns);
  const autoTurns = useAppStore((s) => s.autoFollowUpTurns);
  const autoPaused = useAppStore((s) => s.autoFollowUpPaused);
  const inboxItems = usePrStore((s) => s.inbox?.items);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const { settings } = usePrSettings();
  const workflows = settings?.prWorkflows ?? NO_WORKFLOWS;
  const summaryByKey = useMemo(() => prSummaryLookup(inboxItems ?? [], detailByKey), [inboxItems, detailByKey]);
  return useCallback(
    (session: Session) =>
      babysitState(session, summaryByKey, workflows, {
        busy: busyTurns[session.id] !== undefined,
        paused: autoPaused[session.id],
        autoTurns: autoTurns[session.id] ?? 0
      }),
    [summaryByKey, workflows, busyTurns, autoPaused, autoTurns]
  );
}
