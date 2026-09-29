import { useCallback, useMemo } from "react";
import type { PrSummary, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { firstUnseenPr, needsYouCount, sessionAttention, type Attention } from "./needsYou.js";
import { prSummaryLookup } from "./sessionPrLinks.js";

export interface NeedsYou {
  attentionOf: (session: Session) => Attention | null;
  summaryByKey: Map<string, PrSummary>;
}

export function useNeedsYou(): NeedsYou {
  const pendingApprovals = useAppStore((s) => s.pendingApprovals);
  const pendingQuestions = useAppStore((s) => s.pendingQuestions);
  const inbox = usePrStore((s) => s.inbox);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const inboxItems = inbox?.items;
  const summaryByKey = useMemo(() => prSummaryLookup(inboxItems ?? [], detailByKey), [inboxItems, detailByKey]);
  const attentionOf = useCallback(
    (session: Session): Attention | null =>
      sessionAttention({
        session,
        approvals: pendingApprovals[session.id],
        questions: pendingQuestions[session.id],
        unseenPr: firstUnseenPr(session, summaryByKey, detailByKey)
      }),
    [pendingApprovals, pendingQuestions, summaryByKey, detailByKey]
  );
  return useMemo(() => ({ attentionOf, summaryByKey }), [attentionOf, summaryByKey]);
}

export function useNeedsYouCount(): number {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const { attentionOf } = useNeedsYou();
  return useMemo(() => needsYouCount(Object.values(sessionsByProject).flat(), attentionOf), [sessionsByProject, attentionOf]);
}
