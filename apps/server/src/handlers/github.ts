import type { RunRef } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { assertCountBase, assertSearchKind, assertSearchQuery } from "../github/GitHubSearchService.js";
import { assertIssueRef, assertRepoRef, assertRunRef } from "../github/githubRefs.js";
import { MAX_COUNT_QUERIES } from "../github/issueQueries.js";
import { isValidIssueLink, isValidRunLink } from "../github/prLinks.js";
import { MAX_WATCHED_RUNS } from "../github/RunWatcher.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseList, parseOptionalBoolean, parseRunSources } from "./shared.js";

export function registerGitHubHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "github.search", (args) => {
    const { kind, query, countBase, force } = parseArgs(args, "github.search");
    assertSearchKind(kind);
    assertSearchQuery(query);
    assertCountBase(countBase);
    const forced = parseOptionalBoolean(force, "force");
    const { githubSearch } = services();
    return kind === "pr" ? githubSearch.search("pr", query, countBase, forced) : githubSearch.search("issue", query, countBase, forced);
  });
  handle(router, "github.counts", (args) => {
    const { kind, queries } = parseArgs(args, "github.counts");
    assertSearchKind(kind);
    return services().githubSearch.counts(kind, parseList<string>(queries, MAX_COUNT_QUERIES, "queries", assertSearchQuery));
  });
  handle(router, "github.issueDetail", (args) => {
    const { ref } = parseArgs(args, "github.issueDetail");
    assertIssueRef(ref);
    return services().githubSearch.issueDetail(ref);
  });
  handle(router, "github.runs", (args) => {
    const { sources, force } = parseArgs(args, "github.runs");
    return services().runs.runs(parseRunSources(sources), parseOptionalBoolean(force, "force"));
  });
  handle(router, "github.runLog", (args) => {
    const { ref } = parseArgs(args, "github.runLog");
    assertRunRef(ref);
    return services().runs.runLog(ref);
  });
  handle(router, "github.watchRuns", (args, ctx) => {
    const { refs } = parseArgs(args, "github.watchRuns");
    services();
    app.clientInputs.setRunRefs(ctx.clientId, parseList<RunRef>(refs, MAX_WATCHED_RUNS, "refs", assertRunRef));
    app.syncWatchedRuns();
  });
  handle(router, "github.clone", (args) => {
    const { repo } = parseArgs(args, "github.clone");
    assertRepoRef(repo);
    return services().pullRequests.clone(repo);
  });
  handle(router, "sessions.linkIssue", (args) => {
    const { sessionId, link } = parseArgs(args, "sessions.linkIssue");
    if (typeof sessionId !== "string" || !isValidIssueLink(link)) throw new Error("invalid issue link");
    assertIssueRef(link.ref);
    const { host, owner, repo, number } = link.ref;
    return services().sessions.linkIssue(sessionId, {
      ref: { host, owner, repo, number },
      origin: link.origin,
      ...(link.workflowId !== undefined ? { workflowId: link.workflowId } : {}),
      lastSeenAt: link.lastSeenAt
    });
  });
  handle(router, "sessions.unlinkIssue", (args) => {
    const { sessionId, ref } = parseArgs(args, "sessions.unlinkIssue");
    if (typeof sessionId !== "string") throw new Error("invalid sessionId");
    assertIssueRef(ref);
    return services().sessions.unlinkIssue(sessionId, ref);
  });
  handle(router, "sessions.markIssueSeen", (args) => {
    const { sessionId, ref, seenAt } = parseArgs(args, "sessions.markIssueSeen");
    if (typeof sessionId !== "string") throw new Error("invalid sessionId");
    assertIssueRef(ref);
    if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) throw new Error("invalid seenAt");
    return services().sessions.markIssueSeen(sessionId, ref, seenAt);
  });
  handle(router, "sessions.linkRun", (args) => {
    const { sessionId, link } = parseArgs(args, "sessions.linkRun");
    if (typeof sessionId !== "string" || !isValidRunLink(link)) throw new Error("invalid run link");
    assertRunRef(link.ref);
    const { host, owner, repo, runId } = link.ref;
    return services().sessions.linkRun(sessionId, {
      ref: { host, owner, repo, runId },
      origin: link.origin,
      ...(link.workflowId !== undefined ? { workflowId: link.workflowId } : {}),
      lastSeenAt: link.lastSeenAt
    });
  });
  handle(router, "sessions.unlinkRun", (args) => {
    const { sessionId, ref } = parseArgs(args, "sessions.unlinkRun");
    if (typeof sessionId !== "string") throw new Error("invalid sessionId");
    assertRunRef(ref);
    return services().sessions.unlinkRun(sessionId, ref);
  });
  handle(router, "sessions.markRunSeen", (args) => {
    const { sessionId, ref, seenAt } = parseArgs(args, "sessions.markRunSeen");
    if (typeof sessionId !== "string") throw new Error("invalid sessionId");
    assertRunRef(ref);
    if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) throw new Error("invalid seenAt");
    return services().sessions.markRunSeen(sessionId, ref, seenAt);
  });
}
