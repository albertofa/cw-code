import type { GitPullRequest, PrDetail, PrRef, PrSummary, SessionPrLink } from "../cw.js";
import { prChip, type PrChip } from "./prChip.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";
import { compareUrgency, displayChip, prRefFromUrl, prUrgency, sessionLinks, type PrSummaryLookup } from "./sessionPrLinks.js";

export type SessionPrSource = "linked" | "branch";

export interface SessionPrItem {
  key: string;
  ref: PrRef;
  source: SessionPrSource;
  link?: SessionPrLink;
  chip: PrChip;
  title: string | null;
  url: string;
  state: GitPullRequest["state"];
  supported: boolean;
  headSha: string;
  detail: PrDetail | undefined;
  unseen: boolean;
  urgency: number;
  updatedAt: number;
}

interface LinkedSession {
  prs?: SessionPrLink[];
}

const NO_RECENCY = 0;
const SUPPORTED_HOST = "github.com";

function isSupportedHost(ref: PrRef): boolean {
  return ref.host.toLowerCase() === SUPPORTED_HOST;
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
    state: basis?.state ?? git?.state ?? "OPEN",
    supported: isSupportedHost(link.ref),
    headSha: basis?.headRefOid ?? "",
    detail: detailByKey[key],
    unseen: basis !== undefined && hasUnseen(basis, link),
    urgency: prUrgency(summaryByKey.get(key), git),
    updatedAt: basis?.updatedAt ?? NO_RECENCY
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
  return {
    key,
    ref,
    source: "branch",
    chip,
    title: basis?.title ?? gitPr.title,
    url: gitPr.url,
    state: basis?.state ?? gitPr.state,
    supported: isSupportedHost(ref),
    headSha: basis?.headRefOid ?? "",
    detail: detailByKey[key],
    unseen: false,
    urgency: prUrgency(summaryByKey.get(key), gitPr),
    updatedAt: basis?.updatedAt ?? NO_RECENCY
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

export function canLinkItem(item: SessionPrItem): boolean {
  return item.source === "branch" && item.supported && item.state === "OPEN";
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
