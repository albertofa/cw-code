import type { PrLinkOrigin, PrRef, PrSummary, RepoRef, SessionMeta, SessionPrItem, SessionPrLink } from "@cw-code/contracts";
import { prRefLabel, prRefUrl } from "@cw-code/shared/prRef";
import { findLinkIgnoringCase, resolvePrInput } from "../agent/prInput.js";
import type { ServerApp } from "../app/ServerApp.js";
import type { Services } from "../app/services.js";
import type { Router } from "../transport/Router.js";
import { agentCaller, handle, parseArgs, parseOptionalBoolean, parseString } from "./shared.js";

export interface AgentPrRow {
  pr: string;
  url: string;
  title: string | null;
  state: PrSummary["state"];
  linked: boolean;
  origin: PrLinkOrigin | null;
}

export interface AgentPrLinkReply {
  sessionId: string;
  pr: string;
  url: string;
  state: PrSummary["state"] | null;
  origin: PrLinkOrigin;
  alreadyLinked: boolean;
}

type SessionPrServices = Pick<Services, "sessions" | "git" | "pullRequests" | "sessionPrs">;

function linkOwner(sessions: SessionPrServices["sessions"], callerId: string): SessionMeta {
  const caller = sessions.findSession(callerId);
  if (!caller) throw new Error(`unknown session ${callerId}`);
  const parentId = caller.subagent?.parentSessionId;
  if (parentId === undefined) return caller;
  const parent = sessions.findSession(parentId);
  if (!parent) throw new Error(`unknown session ${parentId}`);
  return parent;
}

async function checkoutRemote(services: SessionPrServices, callerId: string): Promise<RepoRef | null> {
  const remote = await services.git.githubRemote(services.sessions.rootFor(callerId));
  return remote ? { host: remote.host, owner: remote.owner, repo: remote.repository } : null;
}

function parsePrArgs(value: unknown, method: string): { input: string; args: Record<string, unknown> } {
  const args = parseArgs(value, method);
  const input = parseString(args.pr, "pr").trim();
  if (!input) throw new Error("pr must not be empty");
  return { input, args };
}

function agentPrRow(item: SessionPrItem): AgentPrRow {
  return {
    pr: prRefLabel(item.ref),
    url: item.url,
    title: item.title,
    state: item.state,
    linked: item.source === "linked",
    origin: item.link?.origin ?? null
  };
}

function linkReply(sessionId: string, link: SessionPrLink, alreadyLinked: boolean): AgentPrLinkReply {
  return {
    sessionId,
    pr: prRefLabel(link.ref),
    url: prRefUrl(link.ref),
    state: link.snapshot?.state ?? null,
    origin: link.origin,
    alreadyLinked
  };
}

async function newLink(services: SessionPrServices, requested: PrRef, origin: PrLinkOrigin): Promise<SessionPrLink> {
  const head = await services.pullRequests.head(requested);
  if (!head.headRefOid || !head.state) throw new Error(`could not find pull request ${prRefLabel(requested)} on ${requested.host}`);
  const ref = head.ref ?? requested;
  const now = Date.now();
  return {
    ref,
    origin,
    lastSeenSha: head.headRefOid,
    lastSeenAt: now,
    ...(head.updatedAt !== null ? { snapshot: { state: head.state, headRefOid: head.headRefOid, updatedAt: head.updatedAt, syncedAt: now } } : {})
  };
}

async function canonicalRef(services: SessionPrServices, requested: PrRef): Promise<PrRef> {
  try {
    return (await services.pullRequests.head(requested)).ref ?? requested;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[session-prs] could not read ${prRefLabel(requested)} from GitHub; unlinking it with the casing given: ${message}`);
    return requested;
  }
}

export function registerSessionPrHandlers(router: Router, app: Pick<ServerApp, "requireServices">): void {
  const services = (): SessionPrServices => app.requireServices();

  handle<unknown>(router, "sessionPrs.list", (_value, ctx) => {
    const { sessions, sessionPrs } = services();
    const owner = linkOwner(sessions, agentCaller(ctx, "sessionPrs.list"));
    return { sessionId: owner.id, branch: owner.branch ?? null, prs: (sessionPrs.extras(owner.id).prItems ?? []).map(agentPrRow) };
  });

  handle<unknown>(router, "sessionPrs.link", async (value, ctx) => {
    const callerId = agentCaller(ctx, "sessionPrs.link");
    const all = services();
    const { input, args } = parsePrArgs(value, "sessionPrs.link");
    const opened = parseOptionalBoolean(args.opened, "opened") ?? false;
    const owner = linkOwner(all.sessions, callerId);
    const ref = await resolvePrInput(input, () => checkoutRemote(all, callerId));
    const existing = findLinkIgnoringCase(owner.prs, ref);
    if (existing) return linkReply(owner.id, existing, true);
    const link = await newLink(all, ref, opened ? "opened" : "linked");
    const linkedMeanwhile = findLinkIgnoringCase(all.sessions.findSession(owner.id)?.prs, link.ref);
    if (linkedMeanwhile) return linkReply(owner.id, linkedMeanwhile, true);
    all.sessions.linkPr(owner.id, link);
    return linkReply(owner.id, link, false);
  });

  handle<unknown>(router, "sessionPrs.unlink", async (value, ctx) => {
    const callerId = agentCaller(ctx, "sessionPrs.unlink");
    const all = services();
    const { input } = parsePrArgs(value, "sessionPrs.unlink");
    const owner = linkOwner(all.sessions, callerId);
    const requested = await resolvePrInput(input, () => checkoutRemote(all, callerId));
    const existing = findLinkIgnoringCase(owner.prs, requested);
    const ref = existing?.ref ?? (await canonicalRef(all, requested));
    all.sessions.unlinkPr(owner.id, ref);
    return { sessionId: owner.id, pr: prRefLabel(ref), wasLinked: existing !== undefined };
  });
}
