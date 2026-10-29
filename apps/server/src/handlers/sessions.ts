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
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { assertAgentCreateOptions, callerPermissionCap } from "../agent/agentPolicy.js";
import type { ServerApp } from "../app/ServerApp.js";
import type { Services } from "../app/services.js";
import type { SessionStatusReason } from "../debug/sessionStatusTrace.js";
import { expandProjectRoot } from "../skills/skillPaths.js";
import type { Router } from "../transport/Router.js";
import { handle, knownSessionId, parseArgs, parseBoolean, parseString, setComposer } from "./shared.js";

function parseSection(value: unknown, name: string): SidebarSection {
  if (value !== "main" && value !== "resolved") throw new Error(`${name} must be main or resolved`);
  return value;
}

function parseOpenReason(value: unknown): SessionOpenReason {
  if (value !== "select" && value !== "restore") throw new Error("reason must be select or restore");
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

async function assertProjectFolder(rootPath: string): Promise<void> {
  const expanded = expandProjectRoot(rootPath);
  const notFound = new Error(`folder not found on the server: ${expanded}`);
  if (!isAbsolute(expanded)) throw notFound;
  const isFolder = await stat(expanded).then((info) => info.isDirectory(), () => false);
  if (!isFolder) throw notFound;
}

export function registerSessionHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "projects.list", () => services().sessions.listProjects());
  handle<string>(router, "projects.add", async (rootPath) => {
    await assertProjectFolder(rootPath);
    return services().sessions.addProject(rootPath);
  });
  handle<{ projectId: string; settings: ProjectSettings }>(router, "projects.updateSettings", (args) =>
    services().sessions.updateProjectSettings(args.projectId, args.settings)
  );
  handle<string>(router, "sessions.list", (projectId) => services().sessions.listSessions(projectId));
  handle<{ projectId: string; driver: DriverKind; options?: CreateSessionOptions }>(router, "sessions.create", async (args, ctx) => {
    if (ctx.auth.kind !== "agent") return services().sessions.createSession(args.projectId, args.driver, args.options);
    assertAgentCreateOptions(args.options);
    const { sessions } = services();
    const permissionMode = callerPermissionCap(sessions, ctx.auth.sessionId);
    const created = await sessions.createSession(args.projectId, args.driver, args.options);
    const prefs = setComposer(app, created.id, { permissionMode });
    return { ...created, permissionMode: prefs.permissionMode };
  });
  handle<DriverKind>(router, "sessions.importable", (driver) => services().sessions.listImportableSessions(driver));
  handle<ImportSessionRequest>(router, "sessions.import", (request) => services().sessions.importSession(request));
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
  handle<unknown>(router, "sessions.open", (value) => {
    const args = parseArgs(value, "sessions.open");
    return services().sessions.openSession(parseString(args.sessionId, "sessionId"), parseOpenReason(args.reason));
  });
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
  handle<{ sessionId: string; agentId: string }>(router, "sessions.subagentTools", (args) =>
    services().sessions.getSubagentTools(args.sessionId, args.agentId)
  );
  handle<{ sessionId: string }>(router, "sessions.retryConnection", async (args) => {
    const { sessions, threads } = services();
    const result = await sessions.retryConnection(args.sessionId);
    threads.replaceHistory(args.sessionId, result.history);
    return { status: result.status };
  });
  handle<{ sessionId: string }>(router, "threads.reloadHistory", (args) => {
    const { sessions, threads } = services();
    return threads.reloadHistory(knownSessionId(sessions, args.sessionId));
  });
}
