import type { PrRef, SessionPrLink } from "../cw.js";
import { prKey, prRefLabel } from "@cw-code/shared/prRef";

interface LinkedSession {
  prs?: SessionPrLink[];
}

export { prRefLabel };

const NO_LINKS: SessionPrLink[] = [];

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
