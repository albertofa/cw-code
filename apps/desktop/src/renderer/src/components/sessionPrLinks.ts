import type { GitPullRequest, PrDetail, PrLinkSnapshot, PrRef, PrSummary, SessionPrLink } from "../cw.js";
import { prChip, type PrChip, type PrChipTone } from "./prChip.js";
import { prKey, prRefFromUrl } from "@cw-code/shared/prRef";
import { hasUnseen } from "./prUpdates.js";

interface LinkedSession {
  prs?: SessionPrLink[];
}

export { prRefFromUrl };

export type PrSummaryLookup = ReadonlyMap<string, PrSummary>;

const NO_LINKS: SessionPrLink[] = [];

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

export function linkWithWorkflow(session: LinkedSession | undefined, ref: PrRef, workflowId: string): SessionPrLink | null {
  const link = linkFor(session, ref);
  return link && link.workflowId !== workflowId ? { ...link, workflowId } : null;
}

export function sessionsLinkedTo<S extends LinkedSession>(sessions: S[], ref: PrRef): S[] {
  return sessions.filter((session) => linkFor(session, ref) !== undefined);
}

export function prRefLabel(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function mergeSummary(inbox: PrSummary | undefined, tracked: PrSummary | undefined): PrSummary | undefined {
  if (!inbox) return tracked;
  if (!tracked) return inbox;
  return inbox.updatedAt > tracked.updatedAt ? inbox : tracked;
}

export function prSummaryLookup(
  inboxItems: PrSummary[],
  detailByKey: Record<string, PrDetail>,
  trackedByKey: Record<string, PrSummary>
): Map<string, PrSummary> {
  const byKey = new Map<string, PrSummary>(Object.entries(detailByKey));
  const inboxByKey = new Map(inboxItems.map((item) => [prKey(item.ref), item]));
  for (const key of new Set([...inboxByKey.keys(), ...Object.keys(trackedByKey)])) {
    const merged = mergeSummary(inboxByKey.get(key), trackedByKey[key]);
    if (merged) byKey.set(key, merged);
  }
  return byKey;
}

function snapshotChip(link: SessionPrLink, snapshot: PrLinkSnapshot): PrChip {
  const reason = snapshot.state.toLowerCase();
  const icon = snapshot.state === "MERGED" ? "merge" : snapshot.state === "CLOSED" ? "x" : "pr";
  return { tone: "neutral", icon, label: `#${link.ref.number}`, reason, title: `PR #${link.ref.number} · ${reason}` };
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
  const chip = linkChip(link, summaryByKey, gitPr);
  if (chip) return chip;
  if (link.snapshot) return snapshotChip(link, link.snapshot);
  return {
    tone: "neutral",
    icon: "pr",
    label: `#${link.ref.number}`,
    reason: "status not loaded",
    title: `PR #${link.ref.number}`
  };
}

export function prUrgency(summary: PrSummary | undefined, git: GitPullRequest | null, snapshot?: PrLinkSnapshot): number {
  const chip = prChip({ pr: summary ?? null, git });
  if (!chip) return snapshot && snapshot.state !== "OPEN" ? FINISHED_RANK : UNKNOWN_RANK;
  if ((summary?.state ?? git?.state) !== "OPEN") return FINISHED_RANK;
  return TONE_RANK[chip.tone];
}

export function compareUrgency(a: { urgency: number; updatedAt: number }, b: { urgency: number; updatedAt: number }): number {
  return a.urgency - b.urgency || b.updatedAt - a.updatedAt;
}

function urgencyRank(link: SessionPrLink, summaryByKey: PrSummaryLookup, gitPr: GitPullRequest | null | undefined): number {
  return prUrgency(summaryByKey.get(prKey(link.ref)), gitFor(link, gitPr), link.snapshot);
}

export function mostUrgentLink(
  links: SessionPrLink[],
  summaryByKey: PrSummaryLookup,
  gitPr?: GitPullRequest | null
): SessionPrLink | null {
  let best: SessionPrLink | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestUpdated = 0;
  for (const link of links) {
    const rank = urgencyRank(link, summaryByKey, gitPr);
    const updated = summaryByKey.get(prKey(link.ref))?.updatedAt ?? 0;
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
