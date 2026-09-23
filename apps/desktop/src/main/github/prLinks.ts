import type { GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { prRefFromUrl } from "./prParsers.js";

export function linkFromStatus(session: SessionMeta, status: GitStatus, now: number): SessionPrLink | null {
  if (session.pr) return null;
  if (status.pullRequest?.state !== "OPEN") return null;
  const ref = prRefFromUrl(status.pullRequest.url);
  if (!ref) return null;
  return { ref, origin: "opened", lastSeenSha: "", lastSeenAt: now };
}

export function markSeen(link: SessionPrLink, headSha: string | null, now: number): SessionPrLink {
  return { ...link, lastSeenSha: headSha ?? link.lastSeenSha, lastSeenAt: now };
}
