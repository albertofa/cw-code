import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PrSummary, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import { firstUnseenPr, needsYouCount, sessionAttention, unseenPrsNeedingDetail, type Attention } from "./needsYou.js";
import { prKey } from "./prInbox.js";
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

export function useNeedsYouDetailLoader(): void {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const inbox = usePrStore((s) => s.inbox);
  const detailByKey = usePrStore((s) => s.detailByKey);
  const attempted = useRef(new Set<string>());
  const pending = useMemo(
    () => unseenPrsNeedingDetail(Object.values(sessionsByProject).flat(), prSummaryLookup(inbox?.items ?? [], detailByKey), detailByKey),
    [sessionsByProject, inbox, detailByKey]
  );
  const signature = pending.map((pr) => `${prKey(pr.ref)}@${pr.updatedAt}:${pr.headRefOid}`).join(" ");

  useEffect(() => {
    const store = usePrStore.getState();
    for (const pr of pending) {
      const attempt = `${prKey(pr.ref)}@${pr.updatedAt}:${pr.headRefOid}`;
      if (attempted.current.has(attempt)) continue;
      attempted.current.add(attempt);
      void store.loadDetail(pr.ref);
    }
  }, [signature]);
}

export function useNeedsYouCount(): number {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const { attentionOf } = useNeedsYou();
  return useMemo(() => needsYouCount(Object.values(sessionsByProject).flat(), attentionOf), [sessionsByProject, attentionOf]);
}
