import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PrSummary, Session } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { usePrStore } from "../stores/prStore.js";
import {
  firstUnseenPr,
  needsYouCount,
  prVersion,
  sessionAttention,
  shouldRequestDetail,
  unseenPrsNeedingDetail,
  type Attention,
  type DetailAttempt
} from "./needsYou.js";
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
  const loadingByKey = usePrStore((s) => s.detailLoadingByKey);
  const attempts = useRef(new Map<string, DetailAttempt>());
  const fetchedAt = inbox?.fetchedAt ?? 0;
  const pending = useMemo(
    () => unseenPrsNeedingDetail(Object.values(sessionsByProject).flat(), prSummaryLookup(inbox?.items ?? [], detailByKey), detailByKey),
    [sessionsByProject, inbox, detailByKey]
  );
  const signature = pending.map((pr) => `${prKey(pr.ref)}@${prVersion(pr)}`).join(" ");
  const loadingSignature = pending.filter((pr) => loadingByKey[prKey(pr.ref)]).map((pr) => prKey(pr.ref)).join(" ");

  useEffect(() => {
    const store = usePrStore.getState();
    for (const pr of pending) {
      const key = prKey(pr.ref);
      const version = prVersion(pr);
      if (!shouldRequestDetail(attempts.current.get(key), version, fetchedAt, Boolean(store.detailLoadingByKey[key]))) continue;
      attempts.current.set(key, { version, fetchedAt });
      void store.loadDetail(pr.ref);
    }
  }, [signature, loadingSignature, fetchedAt]);
}

export function useNeedsYouCount(): number {
  const sessionsByProject = useAppStore((s) => s.sessionsByProject);
  const { attentionOf } = useNeedsYou();
  return useMemo(() => needsYouCount(Object.values(sessionsByProject).flat(), attentionOf), [sessionsByProject, attentionOf]);
}
