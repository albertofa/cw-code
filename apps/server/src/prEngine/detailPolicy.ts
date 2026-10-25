import type { PrDetail, PrRef, PrWorkflow, SessionMeta } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { autoFollowUpRefs } from "./babysit.js";
import { unseenPrsNeedingDetail } from "./needsYou.js";
import { detailNeedsRefresh, detailRefreshKey } from "./prUpdates.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export interface WantedDetail {
  ref: PrRef;
  version: string;
}

export interface DetailPolicyInput {
  sessions: SessionMeta[];
  lookup: PrSummaryLookup;
  details: ReadonlyMap<string, PrDetail>;
  workflows: PrWorkflow[];
  isSessionOpen(sessionId: string): boolean;
}

export function isFinishedAndCached(detail: PrDetail | undefined): boolean {
  return detail !== undefined && detail.state !== "OPEN";
}

export function wantedDetails({ sessions, lookup, details, workflows, isSessionOpen }: DetailPolicyInput): Map<string, WantedDetail> {
  const wanted = new Map<string, WantedDetail>();
  const want = (ref: PrRef): void => {
    const key = prKey(ref);
    if (!wanted.has(key)) wanted.set(key, { ref, version: detailRefreshKey(key, lookup.get(key)) });
  };

  for (const pr of unseenPrsNeedingDetail(sessions, lookup, Object.fromEntries(details))) want(pr.ref);

  for (const ref of autoFollowUpRefs(sessions, lookup, workflows)) {
    const key = prKey(ref);
    const detail = details.get(key);
    if (!detail || detailNeedsRefresh(detail, lookup.get(key))) want(ref);
  }

  for (const session of sessions) {
    if (!isSessionOpen(session.id)) continue;
    for (const link of sessionLinks(session)) {
      const key = prKey(link.ref);
      const detail = details.get(key);
      if (isFinishedAndCached(detail)) continue;
      if (!detail || detailNeedsRefresh(detail, lookup.get(key))) want(link.ref);
    }
  }
  return wanted;
}
