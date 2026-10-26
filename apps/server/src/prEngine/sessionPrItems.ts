import type { GitPullRequest, PrDetail, PrRef, PrSummary, SessionPrItem, SessionPrLink } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { prChip } from "./prChip.js";
import { hasUnseen } from "./prUpdates.js";
import { compareUrgency, displayChip, prRefFromUrl, prUrgency, sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

interface LinkedSession {
  prs?: SessionPrLink[];
}

const NO_RECENCY = 0;

export function canLink(item: Pick<SessionPrItem, "source" | "state">): boolean {
  return item.source === "branch" && item.state === "OPEN";
}

function refUrl(ref: PrRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

function linkedItem(
  link: SessionPrLink,
  gitPr: GitPullRequest | null,
  branchKey: string | null,
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>
): SessionPrItem {
  const key = prKey(link.ref);
  const basis = summaryByKey.get(key) ?? detailByKey[key];
  const chip = displayChip(link, summaryByKey, gitPr);
  const git = gitPr !== null && branchKey === key ? gitPr : null;
  return {
    key,
    ref: link.ref,
    source: "linked",
    link,
    chip,
    title: basis?.title ?? git?.title ?? null,
    url: basis?.url ?? git?.url ?? refUrl(link.ref),
    state: basis?.state ?? link.snapshot?.state ?? git?.state ?? "OPEN",
    headSha: basis?.headRefOid ?? link.snapshot?.headRefOid ?? "",
    unseen: basis !== undefined && hasUnseen(basis, link),
    urgency: prUrgency(summaryByKey.get(key), git, link.snapshot),
    updatedAt: basis?.updatedAt ?? link.snapshot?.updatedAt ?? NO_RECENCY,
    canLink: false
  };
}

function branchItem(
  ref: PrRef,
  gitPr: GitPullRequest,
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>
): SessionPrItem | null {
  const key = prKey(ref);
  const basis = summaryByKey.get(key) ?? detailByKey[key];
  const chip = prChip({ pr: summaryByKey.get(key) ?? null, git: gitPr });
  if (!chip) return null;
  const state = basis?.state ?? gitPr.state;
  return {
    key,
    ref,
    source: "branch",
    chip,
    title: basis?.title ?? gitPr.title,
    url: gitPr.url,
    state,
    headSha: basis?.headRefOid ?? "",
    unseen: false,
    urgency: prUrgency(summaryByKey.get(key), gitPr),
    updatedAt: basis?.updatedAt ?? NO_RECENCY,
    canLink: canLink({ source: "branch", state })
  };
}

export function sessionPrItems(
  session: LinkedSession | undefined,
  gitPr: GitPullRequest | null,
  summaryByKey: PrSummaryLookup,
  detailByKey: Record<string, PrDetail>,
  branchMismatched = false
): SessionPrItem[] {
  const branchRef = gitPr ? prRefFromUrl(gitPr.url) : null;
  const branchKey = branchRef ? prKey(branchRef) : null;
  const items = sessionLinks(session).map((link) => linkedItem(link, gitPr, branchKey, summaryByKey, detailByKey));
  if (gitPr && branchRef && !branchMismatched && !items.some((item) => item.key === branchKey)) {
    const branch = branchItem(branchRef, gitPr, summaryByKey, detailByKey);
    if (branch) items.push(branch);
  }
  return items.sort(compareUrgency);
}

export function sessionPrItemLabel(item: SessionPrItem): string {
  return item.title ? `#${item.ref.number} · ${item.title}` : `#${item.ref.number}`;
}

export function sessionPrItemsTitle(items: SessionPrItem[]): string {
  return items.map((item) => `${item.chip.label} ${item.chip.reason}`).join(" · ");
}

export function withBranchSummary(
  summaryByKey: PrSummaryLookup,
  gitPr: GitPullRequest | null,
  inboxItems: PrSummary[] | undefined
): PrSummaryLookup {
  const ref = gitPr ? prRefFromUrl(gitPr.url) : null;
  if (!ref) return summaryByKey;
  const key = prKey(ref);
  if (summaryByKey.has(key)) return summaryByKey;
  const found = inboxItems?.find((item) => prKey(item.ref) === key);
  return found ? new Map(summaryByKey).set(key, found) : summaryByKey;
}
