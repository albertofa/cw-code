import type { PrDetail, SessionMeta } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { detailIsCurrent } from "./needsYou.js";
import { hasUnseen, updatesSince } from "./prUpdates.js";
import { sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export function latestUnseenPrUpdateAt(
  session: Pick<SessionMeta, "prs">,
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>
): number | null {
  let latest: number | null = null;
  for (const link of sessionLinks(session)) {
    const key = prKey(link.ref);
    const summary = summaryByKey.get(key);
    const detail = detailByKey[key];
    if (!summary || !hasUnseen(summary, link) || !detailIsCurrent(detail, summary)) continue;
    for (const update of updatesSince(detail, link)) latest = Math.max(latest ?? update.at, update.at);
  }
  return latest;
}
