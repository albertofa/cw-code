import type { CreateSessionOptions, DriverKind, ImportSessionRequest, ProjectSettings, SessionStatus } from "@cw-code/contracts";
import { MAX_TOPICS_PER_CLIENT, sessionTopic } from "@cw-code/shared/topics";
import { homedir } from "node:os";
import type { ServerApp } from "../app/ServerApp.js";
import type { SessionStatusReason } from "../debug/sessionStatusTrace.js";
import type { Router } from "../transport/Router.js";
import { handle, subscribeIfConnected } from "./shared.js";

export function registerSessionHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  const subscribeToSession = (clientId: string, sessionId: string): void => {
    if (app.topics.countFor(clientId) < MAX_TOPICS_PER_CLIENT) subscribeIfConnected(app, clientId, [sessionTopic(sessionId)]);
  };
  handle(router, "projects.list", () => services().sessions.listProjects());
  handle<string>(router, "projects.add", (rootPath) => services().sessions.addProject(rootPath));
  handle<{ projectId: string; settings: ProjectSettings }>(router, "projects.updateSettings", (args) =>
    services().sessions.updateProjectSettings(args.projectId, args.settings)
  );
  handle(router, "os.homeDir", () => homedir());
  handle<string>(router, "sessions.list", (projectId) => services().sessions.listSessions(projectId));
  handle<{ projectId: string; driver: DriverKind; options?: CreateSessionOptions }>(router, "sessions.create", async (args, ctx) => {
    const session = await services().sessions.createSession(args.projectId, args.driver, args.options);
    subscribeToSession(ctx.clientId, session.id);
    return session;
  });
  handle<DriverKind>(router, "sessions.importable", (driver) => services().sessions.listImportableSessions(driver));
  handle<ImportSessionRequest>(router, "sessions.import", async (request, ctx) => {
    const result = await services().sessions.importSession(request);
    subscribeToSession(ctx.clientId, result.session.id);
    return result;
  });
  handle<{ sessionId: string; title: string }>(router, "sessions.rename", (args) =>
    services().sessions.renameSession(args.sessionId, args.title)
  );
  handle<{ sessionId: string }>(router, "sessions.regenerateTitle", (args) => services().sessions.regenerateTitle(args.sessionId));
  handle<{ sessionId: string; status: SessionStatus; reason?: SessionStatusReason }>(router, "sessions.setStatus", (args) => {
    const { sessions, ptys, fileWatcher } = services();
    const updated = sessions.setSessionStatus(args.sessionId, args.status, args.reason);
    if (updated.status === "resolved" || updated.status === "archived") {
      ptys.killSession(args.sessionId);
      void fileWatcher.unwatch(args.sessionId);
    }
    return updated;
  });
  handle<{ sessionId: string }>(router, "sessions.markWorking", (args) => services().sessions.markWorking(args.sessionId));
  handle<{ sessionId: string }>(router, "sessions.restore", (args) => services().sessions.restoreSession(args.sessionId));
  handle<string[]>(router, "sessions.expireHolding", (sessionIds) => services().sessions.expireHoldingSessions(sessionIds));
  handle<{ sessionId: string; status: SessionStatus; removeWorktree?: boolean; forceBranch?: boolean }>(
    router,
    "sessions.resolve",
    async (args) => {
      const { sessions, ptys, fileWatcher } = services();
      await fileWatcher.unwatch(args.sessionId);
      const result = await sessions.resolveSession(args.sessionId, args.status, { removeWorktree: args.removeWorktree, forceBranch: args.forceBranch });
      if (result.status === "resolved" || result.status === "archived") ptys.killSession(args.sessionId);
      return result;
    }
  );
  handle(router, "worktrees.prune", async () => {
    const { sessions, fileWatcher } = services();
    const perProject = await Promise.all(sessions.listProjects().map((project) => sessions.listSessions(project.id)));
    const unpinned = perProject
      .flat()
      .filter((session) => session.status === "resolved" || session.status === "archived");
    await Promise.all(unpinned.map((session) => fileWatcher.unwatch(session.id)));
    return sessions.pruneStaleWorktrees();
  });
  handle<{ sessionId: string }>(router, "sessions.history", (args) => services().sessions.getHistory(args.sessionId));
  handle<{ sessionId: string; agentId: string }>(router, "sessions.subagentTools", (args) =>
    services().sessions.getSubagentTools(args.sessionId, args.agentId)
  );
  handle(router, "sessions.activeTurns", () => services().sessions.listActiveTurns());
  handle<{ sessionId: string }>(router, "sessions.retryConnection", (args) => services().sessions.retryConnection(args.sessionId));
}
