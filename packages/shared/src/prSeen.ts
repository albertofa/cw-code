import type { PrSummary, SessionPrLink } from "@cw-code/contracts";

export function hasUnseen(pr: Pick<PrSummary, "state" | "headRefOid" | "updatedAt">, link: SessionPrLink): boolean {
  if (pr.state !== "OPEN") return false;
  return (link.lastSeenSha !== "" && pr.headRefOid !== link.lastSeenSha) || pr.updatedAt > link.lastSeenAt;
}
