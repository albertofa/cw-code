import type { AppSettings, PrDetail, PrSuggestCondition, PrSummary, PrUpdate, PrWorkflow, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { linkFor, pickMainSession } from "./sessionPrLinks.js";

export const TEMPLATE_VARS = [
  "pr.number",
  "pr.title",
  "pr.body",
  "pr.url",
  "pr.repo",
  "pr.head",
  "pr.base",
  "pr.sha",
  "pr.diffStat",
  "pr.threads",
  "pr.unresolvedThreads",
  "checks.summary",
  "checks.failedLogs",
  "pr.delta",
  "session.lastSeenSha",
  "attribution",
  "harness"
] as const;

export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

function formatThreads(threads: PrDetail["threads"]): string {
  return threads
    .map((thread) => {
      const first = thread.comments[0];
      const location = thread.line !== null ? `${thread.path}:${thread.line}` : thread.path;
      return `- ${location} — ${first ? `${first.author}: ${first.body}` : "no comments"}`;
    })
    .join("\n");
}

function formatChecksSummary(checkRuns: PrDetail["checkRuns"]): string {
  if (checkRuns.length === 0) return "no checks";
  const passed = checkRuns.filter((c) => c.status === "success" || c.status === "skipped").length;
  const failing = checkRuns.filter((c) => c.status === "failure");
  const pending = checkRuns.filter((c) => c.status === "pending").length;
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failing.length > 0) parts.push(`${failing.length} failing (${failing.map((c) => c.name).join(", ")})`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.length > 0 ? parts.join(", ") : "no checks";
}

export function templateVars(
  pr: PrDetail,
  opts: { link?: SessionPrLink; updates?: PrUpdate[]; failedLogs?: string; attribution: string; harness: string }
): Record<string, string> {
  const unresolved = pr.threads.filter((t) => !t.isResolved);
  return {
    "pr.number": String(pr.ref.number),
    "pr.title": pr.title,
    "pr.body": pr.body,
    "pr.url": pr.url,
    "pr.repo": `${pr.ref.owner}/${pr.ref.repo}`,
    "pr.head": pr.headRefName,
    "pr.base": pr.baseRefName,
    "pr.sha": pr.headRefOid,
    "pr.diffStat": `+${pr.additions} −${pr.deletions}, ${pr.changedFiles} files`,
    "pr.threads": formatThreads(pr.threads),
    "pr.unresolvedThreads": formatThreads(unresolved),
    "checks.summary": formatChecksSummary(pr.checkRuns),
    "checks.failedLogs": opts.failedLogs ?? "",
    "pr.delta": (opts.updates ?? []).map((u) => u.summary).join("\n"),
    "session.lastSeenSha": opts.link?.lastSeenSha ?? "",
    attribution: opts.attribution,
    harness: opts.harness
  };
}

export function attributionText(settings: Pick<AppSettings, "prAttributionEnabled" | "prAttributionText">, harness: string): string {
  if (!settings.prAttributionEnabled) return "";
  return resolveTemplate(settings.prAttributionText, { harness });
}

export function matchesCondition(pr: PrSummary, c: PrSuggestCondition): boolean {
  switch (c) {
    case "review-requested":
      return !pr.viewerIsAuthor && pr.reviewRequestedFromViewer;
    case "author":
      return pr.viewerIsAuthor;
    case "checks-failing":
      return pr.ci === "failing";
    case "changes-requested":
      return pr.review === "changes_requested";
    case "conflicts":
      return pr.mergeable === "CONFLICTING";
    case "bot-author":
      return pr.author.isBot;
    case "draft":
      return pr.isDraft;
    default:
      return false;
  }
}

export function suggestedWorkflow(pr: PrSummary, workflows: PrWorkflow[]): PrWorkflow | null {
  return workflows.find((w) => w.enabled && w.suggestWhen.some((c) => matchesCondition(pr, c))) ?? null;
}

export type PrPrimaryAction =
  | { kind: "open"; sessionId: string }
  | { kind: "continue"; sessionId: string; workflowId: string }
  | { kind: "run"; workflowId: string }
  | { kind: "none" };

export function primaryAction(pr: PrSummary, linked: SessionMeta[], workflows: PrWorkflow[]): PrPrimaryAction {
  if (pr.state === "MERGED") return { kind: "none" };
  const session = pickMainSession(linked, pr.ref);
  const link = session ? linkFor(session, pr.ref) : undefined;
  if (session && link?.workflowId === "review" && pr.headRefOid !== link.lastSeenSha) {
    return { kind: "continue", sessionId: session.id, workflowId: "review" };
  }
  if (session) return { kind: "open", sessionId: session.id };
  const suggested = suggestedWorkflow(pr, workflows);
  if (suggested) return { kind: "run", workflowId: suggested.id };
  return { kind: "none" };
}
