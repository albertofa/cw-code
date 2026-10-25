import type {
  CreateSessionOptions,
  DriverKind,
  ImportSessionRequest,
  ProjectSettings,
  SessionCleanupResult,
  SessionOpenReason,
  SessionStatus,
  SidebarReorderRequest,
  SidebarSection
} from "@cw-code/contracts";
import { MAX_TOPICS_PER_CLIENT, sessionTopic } from "@cw-code/shared/topics";
import { homedir } from "node:os";
import type { ServerApp } from "../app/ServerApp.js";
import type { Services } from "../app/services.js";
import type { SessionStatusReason } from "../debug/sessionStatusTrace.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, parseBoolean, parseString, subscribeIfConnected } from "./shared.js";

function parseSection(value: unknown, name: string): SidebarSection {
  if (value !== "main" && value !== "resolved") throw new Error(`${name} must be main or resolved`);
  return value;
}

function parseSidebarReorder(value: unknown): SidebarReorderRequest {
  const args = parseArgs(value, "sidebar.reorder");
  return {
    sessionId: parseString(args.sessionId, "sessionId"),
    from: parseSection(args.from, "from"),
    to: parseSection(args.to, "to"),
    targetId: args.targetId === null ? null : parseString(args.targetId, "targetId"),
    before: parseBoolean(args.before, "before")
  };
}

async function resolveSession(
  { sessions, ptys, fileWatcher }: Services,
  sessionId: string,
  status: SessionStatus,
  options: { removeWorktree?: boolean; forceBranch?: boolean }
): Promise<SessionCleanupResult> {
  await fileWatcher.unwatch(sessionId);
  const result = await sessions.resolveSession(sessionId, status, options);
  if (result.status === "resolved" || result.status === "archived") ptys.killSession(sessionId);
  return result;
}

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
  handle<{ sessionId: string }>(router, "sessions.markTurnSeen", (args) => services().sessions.markTurnSeen(args.sessionId));
  handle<{ sessionId: string; reason: SessionOpenReason }>(router, "sessions.open", (args) =>
    services().sessions.openSession(args.sessionId, args.reason)
  );
  handle<{ sessionId: string }>(router, "sessions.pauseAutoFollowUp", (args) => {
    if (!services().autoFollowUp.pause(args.sessionId)) throw new Error(`unknown session ${args.sessionId}`);
  });
  handle<{ sessionId: string }>(router, "sessions.resumeAutoFollowUp", (args) => {
    if (!services().autoFollowUp.resume(args.sessionId)) throw new Error(`unknown session ${args.sessionId}`);
  });
  handle<{ sessionId: string; status: SessionStatus; removeWorktree?: boolean; forceBranch?: boolean }>(
    router,
    "sessions.resolve",
    (args) => resolveSession(services(), args.sessionId, args.status, { removeWorktree: args.removeWorktree, forceBranch: args.forceBranch })
  );
  handle<unknown>(router, "sidebar.reorder", async (args) => {
    const request = parseSidebarReorder(args);
    await services().sidebar.reorder(request, (action) =>
      action === "resolve"
        ? resolveSession(services(), request.sessionId, "resolved", { removeWorktree: true, forceBranch: false })
        : services().sessions.restoreSession(request.sessionId)
    );
  });
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
  handle<{ sessionId: string }>(router, "sessions.retryConnection", async (args) => {
    const { sessions, threads } = services();
    const result = await sessions.retryConnection(args.sessionId);
    threads.replaceHistory(args.sessionId, result.history);
    return result;
  });
  handle<{ sessionId: string }>(router, "threads.reloadHistory", (args) => services().threads.reloadHistory(args.sessionId));
}
