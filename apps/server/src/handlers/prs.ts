import type { PrRef, ProjectGitHubRepo, SessionPrLink } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { assertPrRef } from "../github/PullRequestService.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerPrHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "prs.tracked", () => services().prTracker.summaries());
  handle<{ force?: boolean } | undefined>(router, "prs.inbox", (args) => services().pullRequests.inbox(args?.force));
  handle<{ ref: PrRef }>(router, "prs.detail", (args) => services().pullRequests.detail(args.ref));
  handle<{ ref: PrRef }>(router, "prs.diff", (args) => services().pullRequests.diff(args.ref));
  handle<{ ref: PrRef; runId: number }>(router, "prs.checkLog", (args) => services().pullRequests.failedCheckLog(args.ref, args.runId));
  handle(router, "prs.projectRepos", async (): Promise<ProjectGitHubRepo[]> => {
    const { sessions, git } = services();
    const repos = await Promise.all(
      sessions.listProjects().map(async (project) => {
        const remote = await git.githubRemote(project.rootPath).catch(() => null);
        return remote ? { projectId: project.id, host: remote.host, owner: remote.owner, repo: remote.repository } : null;
      })
    );
    return repos.filter((repo): repo is ProjectGitHubRepo => repo !== null);
  });
  handle<{ sessionId: string; link: SessionPrLink }>(router, "sessions.linkPr", (args) => {
    const link = args.link;
    assertPrRef(link.ref);
    if (link.origin !== "opened" && link.origin !== "workflow" && link.origin !== "linked") {
      throw new Error(`invalid pull request link origin '${String(link.origin)}'`);
    }
    if (link.workflowId !== undefined && typeof link.workflowId !== "string") {
      throw new Error("invalid workflowId");
    }
    if (typeof link.lastSeenSha !== "string") throw new Error("invalid lastSeenSha");
    if (typeof link.lastSeenAt !== "number" || !Number.isFinite(link.lastSeenAt)) throw new Error("invalid lastSeenAt");
    return services().sessions.linkPr(args.sessionId, {
      ref: link.ref,
      origin: link.origin,
      ...(link.workflowId !== undefined ? { workflowId: link.workflowId } : {}),
      lastSeenSha: link.lastSeenSha,
      lastSeenAt: link.lastSeenAt
    });
  });
  handle<{ sessionId: string; ref: PrRef }>(router, "sessions.unlinkPr", (args) => {
    assertPrRef(args.ref);
    return services().sessions.unlinkPr(args.sessionId, args.ref);
  });
  handle<{ sessionId: string; ref: PrRef; headSha: string | null; seenAt: number | null }>(router, "sessions.markPrSeen", (args) => {
    assertPrRef(args.ref);
    if (args.headSha !== null && typeof args.headSha !== "string") throw new Error("invalid headSha");
    if (args.seenAt !== null && !Number.isFinite(args.seenAt)) throw new Error("invalid seenAt");
    return services().sessions.markPrSeen(args.sessionId, args.ref, args.headSha, args.seenAt);
  });
}
