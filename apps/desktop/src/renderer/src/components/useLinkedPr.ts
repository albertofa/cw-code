import { useMemo } from "react";
import type { PrDetail, PrSummary, Session, SessionPrLink } from "../cw.js";
import { useAppStore } from "../stores/appStore.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";
import { branchMismatch } from "./sessionBranch.js";
import { sessionPrItems, type SessionPrItem } from "./sessionPrItems.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";
import { usePrDetailEntries, usePrDetails, usePrSummaries } from "./usePrs.js";

export interface LinkedPr {
  key: string;
  link: SessionPrLink;
  summary: PrSummary | undefined;
  detail: PrDetail | undefined;
  loading: boolean;
  error: string | undefined;
  unseen: boolean;
}

export interface LinkedPrs {
  session: Session | undefined;
  items: LinkedPr[];
  summaryByKey: PrSummaryLookup;
}

export function findSession(sessionsByProject: Record<string, Session[]>, sessionId: string): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const found = list.find((item) => item.id === sessionId);
    if (found) return found;
  }
  return undefined;
}

export function useLinkedPrs(sessionId: string): LinkedPrs {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const links = sessionLinks(session);
  const summaries = usePrSummaries();
  const entries = usePrDetailEntries();

  return useMemo(() => {
    const summaryByKey = new Map<string, PrSummary>();
    const items = links.map((link): LinkedPr => {
      const key = prKey(link.ref);
      const entry = entries.get(key);
      const detail = entry?.detail ?? undefined;
      const summary = summaries.get(key);
      const basis = summary ?? detail;
      if (basis) summaryByKey.set(key, basis);
      return {
        key,
        link,
        summary,
        detail,
        loading: entry?.loading ?? false,
        error: entry?.error ?? undefined,
        unseen: basis !== undefined && hasUnseen(basis, link)
      };
    });
    return { session, items, summaryByKey };
  }, [session, links, summaries, entries]);
}

export function useSessionPrItems(sessionId: string): { items: SessionPrItem[]; session: Session | undefined } {
  const session = useAppStore((s) => findSession(s.sessionsByProject, sessionId));
  const summaries = usePrSummaries();
  const gitStatus = useAppStore((s) => s.gitStatusBySession[sessionId]);
  const gitPr = gitStatus?.pullRequest ?? null;
  const detailByKey = usePrDetails();
  const mismatched = branchMismatch(session, gitStatus) !== null;
  const items = useMemo(
    () => sessionPrItems(session, gitPr, summaries, detailByKey, mismatched),
    [session, gitPr, summaries, detailByKey, mismatched]
  );
  return { items, session };
}
