import type { PrDetail, PrLinkSnapshot, PrRef, PrSummary, PrWorkflow, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { autoFollowUpWorkflow } from "@cw-code/shared/autoFollowUp";
import { prKey } from "@cw-code/shared/prRef";
import { autoFollowUpRefs } from "./babysit.js";
import { unseenPrsNeedingDetail } from "./needsYou.js";
import { detailNeedsRefresh, detailRefreshKey, hasUnseen } from "./prUpdates.js";
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
  watched: ReadonlyMap<string, PrRef>;
  isSessionOpen(sessionId: string): boolean;
}

export interface DetailPolicyResult {
  wanted: Map<string, WantedDetail>;
  retained: Set<string>;
}

export function isFinishedAndCached(detail: PrDetail | undefined): boolean {
  return detail !== undefined && detail.state !== "OPEN";
}

function isLive(session: SessionMeta): boolean {
  return session.status !== "resolved" && session.status !== "archived";
}

const FINISHED_STATES: ReadonlySet<PrLinkSnapshot["state"]> = new Set(["MERGED", "CLOSED"]);

/**
 * The link already records that the PR is finished and no summary contradicts it. The snapshot is
 * often the only state the app keeps for a merged PR (the tracker stops polling those), so a
 * missing summary must not turn it back into a link worth fetching.
 */
function finishedWithoutSummary(link: SessionPrLink, summary: PrSummary | undefined): boolean {
  return summary === undefined && link.snapshot !== undefined && FINISHED_STATES.has(link.snapshot.state);
}

export function detailPolicy({ sessions, lookup, details, workflows, watched, isSessionOpen }: DetailPolicyInput): DetailPolicyResult {
  const wanted = new Map<string, WantedDetail>();
  const retained = new Set<string>();
  const finished = new Set<string>();
  const want = (ref: PrRef): void => {
    const key = prKey(ref);
    if (!wanted.has(key)) wanted.set(key, { ref, version: detailRefreshKey(key, lookup.get(key)) });
  };

  for (const pr of unseenPrsNeedingDetail(sessions, lookup, Object.fromEntries(details))) want(pr.ref);
  for (const session of sessions) {
    if (!isLive(session)) continue;
    for (const link of sessionLinks(session)) {
      const key = prKey(link.ref);
      const summary = lookup.get(key);
      if (summary && hasUnseen(summary, link)) retained.add(key);
      if (finishedWithoutSummary(link, summary)) finished.add(key);
      // A followed PR stays referenced while its session lives. Without this a detail that revealed
      // a merged PR would be evicted as unused, and the next change would reload it from scratch.
      if (autoFollowUpWorkflow(link, workflows)) retained.add(key);
    }
  }

  for (const ref of autoFollowUpRefs(sessions, lookup, workflows)) {
    const key = prKey(ref);
    retained.add(key);
    if (finished.has(key)) continue;
    const detail = details.get(key);
    if (!detail || detailNeedsRefresh(detail, lookup.get(key))) want(ref);
  }

  for (const [key, ref] of watched) {
    retained.add(key);
    const detail = details.get(key);
    if (!detail || detailNeedsRefresh(detail, lookup.get(key))) want(ref);
  }

  for (const session of sessions) {
    if (!isSessionOpen(session.id)) continue;
    for (const link of sessionLinks(session)) {
      const key = prKey(link.ref);
      retained.add(key);
      const detail = details.get(key);
      if (isFinishedAndCached(detail)) continue;
      if (!detail || detailNeedsRefresh(detail, lookup.get(key))) want(link.ref);
    }
  }
  return { wanted, retained };
}
