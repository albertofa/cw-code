import type { GitPullRequest, PrDetail, PrRef, PrSummary, SessionPrLink } from "../cw.js";
import { prChip, type PrChip, type PrChipTone } from "./prChip.js";
import { prKey } from "./prInbox.js";
import { hasUnseen } from "./prUpdates.js";

interface LinkedSession {
  prs?: SessionPrLink[];
}

export type PrSummaryLookup = ReadonlyMap<string, PrSummary>;

const NO_LINKS: SessionPrLink[] = [];

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

const TONE_RANK: Record<PrChipTone, number> = { bad: 0, info: 1, warn: 2, neutral: 3, ok: 4 };
const UNKNOWN_RANK = 5;
const FINISHED_RANK = 6;

export function sessionLinks(session: LinkedSession | undefined): SessionPrLink[] {
  return session?.prs ?? NO_LINKS;
}

export function linkFor(session: LinkedSession | undefined, ref: PrRef): SessionPrLink | undefined {
  const key = prKey(ref);
  return sessionLinks(session).find((link) => prKey(link.ref) === key);
}

export function sessionsLinkedTo<S extends LinkedSession>(sessions: S[], ref: PrRef): S[] {
  return sessions.filter((session) => linkFor(session, ref) !== undefined);
}

export function prRefLabel(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prRefFromUrl(url: string): PrRef | null {
  const match = PR_URL_RE.exec(url.trim());
  if (!match) return null;
  const number = Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], number };
}

export function prSummaryLookup(inboxItems: PrSummary[], detailByKey: Record<string, PrDetail>): Map<string, PrSummary> {
  const byKey = new Map<string, PrSummary>(Object.entries(detailByKey));
  for (const item of inboxItems) byKey.set(prKey(item.ref), item);
  return byKey;
}

function gitFor(link: SessionPrLink, gitPr: GitPullRequest | null | undefined): GitPullRequest | null {
  if (!gitPr) return null;
  const ref = prRefFromUrl(gitPr.url);
  return ref && prKey(ref) === prKey(link.ref) ? gitPr : null;
}

export function linkChip(link: SessionPrLink, summaryByKey: PrSummaryLookup, gitPr?: GitPullRequest | null): PrChip | null {
  return prChip({ pr: summaryByKey.get(prKey(link.ref)) ?? null, git: gitFor(link, gitPr) });
}

export function displayChip(link: SessionPrLink, summaryByKey: PrSummaryLookup, gitPr?: GitPullRequest | null): PrChip {
  return (
    linkChip(link, summaryByKey, gitPr) ?? {
      tone: "neutral",
      icon: "pr",
      label: `#${link.ref.number}`,
      reason: "status not loaded",
      title: `PR #${link.ref.number}`
    }
  );
}

function urgencyRank(link: SessionPrLink, summaryByKey: PrSummaryLookup, gitPr: GitPullRequest | null | undefined): number {
  const summary = summaryByKey.get(prKey(link.ref));
  const git = gitFor(link, gitPr);
  const chip = prChip({ pr: summary ?? null, git });
  if (!chip) return UNKNOWN_RANK;
  if ((summary?.state ?? git?.state) !== "OPEN") return FINISHED_RANK;
  return TONE_RANK[chip.tone];
}

export function mostUrgentLink(
  links: SessionPrLink[],
  summaryByKey: PrSummaryLookup,
  gitPr?: GitPullRequest | null
): SessionPrLink | null {
  let best: SessionPrLink | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestUpdated = Number.NEGATIVE_INFINITY;
  for (const link of links) {
    const rank = urgencyRank(link, summaryByKey, gitPr);
    const updated = summaryByKey.get(prKey(link.ref))?.updatedAt ?? Number.NEGATIVE_INFINITY;
    if (rank < bestRank || (rank === bestRank && updated > bestUpdated)) {
      best = link;
      bestRank = rank;
      bestUpdated = updated;
    }
  }
  return best;
}

export function linksTitle(links: SessionPrLink[], summaryByKey: PrSummaryLookup, gitPr?: GitPullRequest | null): string {
  return links
    .map((link) => {
      const chip = linkChip(link, summaryByKey, gitPr);
      return chip ? `${chip.label} ${chip.reason}` : `#${link.ref.number}`;
    })
    .join(" · ");
}

export function anyLinkUnseen(links: SessionPrLink[], summaryByKey: PrSummaryLookup): boolean {
  return links.some((link) => {
    const summary = summaryByKey.get(prKey(link.ref));
    return summary !== undefined && hasUnseen(summary, link);
  });
}

export function pickMainSession<S extends LinkedSession & { updatedAt: number }>(sessions: S[], ref: PrRef): S | null {
  const linked = sessionsLinkedTo(sessions, ref);
  if (linked.length === 0) return null;
  const opened = linked.find((session) => linkFor(session, ref)?.origin === "opened");
  if (opened) return opened;
  const review = linked.find((session) => linkFor(session, ref)?.workflowId === "review");
  if (review) return review;
  return linked.reduce((latest, session) => (session.updatedAt > latest.updatedAt ? session : latest));
}
