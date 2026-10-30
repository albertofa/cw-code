import type { ComposerPrefs, PermissionMode, Project, SessionMeta } from "@cw-code/contracts";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentTurnPermissionMode, SAFE_MODEL_ID } from "../agent/agentPolicy.js";
import type { SessionWatch } from "../agent/SessionWatch.js";
import { PERMISSION_MODES } from "../providers/permissions.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { CallContext, Router } from "../transport/Router.js";

export interface CwToolsDeps {
  router: Router;
  watch: Pick<SessionWatch, "wait" | "lastResult">;
  sessions: Pick<SessionManager, "getComposer" | "turnPermissionMode">;
  callerSessionId: string;
}

export const WAIT_DEFAULT_MS = 120_000;
export const WAIT_MIN_MS = 1_000;
export const WAIT_MAX_MS = 240_000;
export const WAIT_PROGRESS_INTERVAL_MS = 15_000;

const DRIVERS = ["claude", "codex", "opencode"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const HIDDEN_STATUSES: ReadonlySet<SessionMeta["status"]> = new Set(["resolved", "archived"]);
const READ_ONLY = { readOnlyHint: true } as const;

const CW_TOOL_SPECS = {
  projects_list: { description: "List the cw-code projects (id, name, rootPath).", inputSchema: z.object({}), annotations: READ_ONLY },
  sessions_list: {
    description:
      "List cw-code sessions as {id, projectId, driver, title, status, branch, updatedAt}. Omit projectId for every project. Resolved and archived sessions are hidden unless includeResolved is true.",
    inputSchema: z.object({ projectId: z.string().optional(), includeResolved: z.boolean().default(false) }),
    annotations: READ_ONLY
  },
  session_get: {
    description: "Get one session: its list row plus model, permissionMode, worktreePath and the text of its last finished turn (lastResultText).",
    inputSchema: z.object({ sessionId: z.string() }),
    annotations: READ_ONLY
  },
  session_create: {
    description:
      "Create a session in a project and start its first turn with prompt. permissionMode is capped at your own session's mode. Returns {sessionId, turnId, permissionMode}. Use session_wait to wait for it.",
    inputSchema: z.object({
      projectId: z.string(),
      driver: z.enum(DRIVERS),
      prompt: z.string().min(1),
      model: z.string().regex(SAFE_MODEL_ID, "not a valid model id").optional(),
      effort: z.enum(EFFORTS).optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
      useWorktree: z.boolean().optional()
    })
  },
  session_send: {
    description: "Send a prompt to another session as a new turn. Fails if that session is already working or is your own session. Returns {turnId}.",
    inputSchema: z.object({ sessionId: z.string(), prompt: z.string().min(1) })
  },
  session_stop: {
    description: "Interrupt the running turn of another session (not your own). Returns {stopped}.",
    inputSchema: z.object({ sessionId: z.string() })
  },
  session_wait: {
    description: `Block until another session (not your own) stops working or timeoutMs passes (default ${WAIT_DEFAULT_MS}, ${WAIT_MIN_MS}-${WAIT_MAX_MS}). Returns {status, lastResultText, timedOut}; returns at once if the session is not working.`,
    inputSchema: z.object({ sessionId: z.string(), timeoutMs: z.number().int().optional() }),
    annotations: READ_ONLY
  },
  usage_report: {
    description:
      "Token and cost usage over the last `days` days. metric 'all' counts every token, 'fresh' excludes cache reads. driver and projectId accept 'all'.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(366),
      metric: z.enum(["all", "fresh"]),
      driver: z.enum([...DRIVERS, "all"]),
      projectId: z.string()
    }),
    annotations: READ_ONLY
  },
  settings_get: { description: "Read the cw-code app settings.", inputSchema: z.object({}), annotations: READ_ONLY },
  settings_set: {
    description: "Change cw-code app settings with a partial patch (only model, worktree, session lifecycle and refresh settings are writable). Returns the full settings.",
    inputSchema: z.object({ patch: z.record(z.string(), z.unknown()) })
  }
};

export interface CwToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function cwToolDefinitions(): CwToolDefinition[] {
  return Object.entries(CW_TOOL_SPECS).map(([name, spec]) => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.inputSchema, { io: "input" });
    return { name, description: spec.description, inputSchema };
  });
}

interface SessionRow {
  id: string;
  projectId: string;
  driver: SessionMeta["driver"];
  title: string;
  status: SessionMeta["status"];
  branch: string | null;
  updatedAt: number;
}

function sessionRow(session: SessionMeta): SessionRow {
  return {
    id: session.id,
    projectId: session.projectId,
    driver: session.driver,
    title: session.title,
    status: session.status,
    branch: session.branch ?? null,
    updatedAt: session.updatedAt
  };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(JSON.stringify((await action()) ?? null));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message || "the call failed without an error message", true);
  }
}

function clampWait(timeoutMs: number | undefined): number {
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, timeoutMs ?? WAIT_DEFAULT_MS));
}

function definedPrefs(prefs: { model?: string; effort?: string; permissionMode?: PermissionMode }): Record<string, string> {
  return Object.fromEntries(Object.entries(prefs).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function registerCwTools(server: McpServer, deps: CwToolsDeps): void {
  const ctx: CallContext = { clientId: `mcp:${deps.callerSessionId}`, client: "mcp", auth: { kind: "agent", sessionId: deps.callerSessionId } };
  const call = (method: string, params?: unknown): Promise<unknown> => deps.router.dispatch(method, params, ctx);

  const listSessions = async (projectId: string | undefined): Promise<SessionMeta[]> => {
    const projectIds = projectId !== undefined ? [projectId] : ((await call("projects.list")) as Project[]).map((project) => project.id);
    const perProject = await Promise.all(projectIds.map((id) => call("sessions.list", id) as Promise<SessionMeta[]>));
    return perProject.flat();
  };

  const assertNotOwnSession = (sessionId: string, action: string): void => {
    if (sessionId === deps.callerSessionId) throw new Error(`an agent cannot ${action} its own session`);
  };

  server.registerTool("projects_list", CW_TOOL_SPECS.projects_list, () => run(() => call("projects.list")));

  server.registerTool("sessions_list", CW_TOOL_SPECS.sessions_list, ({ projectId, includeResolved }) =>
    run(async () => {
      const sessions = await listSessions(projectId);
      return sessions.filter((session) => includeResolved || !HIDDEN_STATUSES.has(session.status)).map(sessionRow);
    })
  );

  server.registerTool("session_get", CW_TOOL_SPECS.session_get, ({ sessionId }) =>
    run(async () => {
      const session = (await listSessions(undefined)).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const composer = (await call("composer.get", { sessionId })) as ComposerPrefs;
      return {
        ...sessionRow(session),
        model: session.model ?? null,
        permissionMode: composer.permissionMode ?? null,
        worktreePath: session.worktreePath ?? null,
        lastResultText: deps.watch.lastResult(sessionId)
      };
    })
  );

  server.registerTool("session_create", CW_TOOL_SPECS.session_create, ({ projectId, driver, prompt, model, effort, permissionMode, useWorktree }) =>
    run(async () => {
      const session = (await call("sessions.create", { projectId, driver, options: { useWorktree } })) as SessionMeta;
      let turnId: string;
      try {
        turnId = (await call("turns.start", { sessionId: session.id, prompt, prefs: definedPrefs({ model, effort, permissionMode }) })) as string;
      } catch (error) {
        throw new Error(`session ${session.id} was created but its first turn did not start: ${(error as Error).message}`);
      }
      return {
        sessionId: session.id,
        turnId,
        permissionMode: agentTurnPermissionMode(deps.sessions, session.id, deps.callerSessionId, permissionMode)
      };
    })
  );

  server.registerTool("session_send", CW_TOOL_SPECS.session_send, ({ sessionId, prompt }) =>
    run(async () => {
      assertNotOwnSession(sessionId, "send a prompt to");
      return { turnId: await call("turns.start", { sessionId, prompt }) };
    })
  );

  server.registerTool("session_stop", CW_TOOL_SPECS.session_stop, ({ sessionId }) =>
    run(async () => {
      assertNotOwnSession(sessionId, "stop");
      return call("turns.stop", { sessionId });
    })
  );

  server.registerTool("session_wait", CW_TOOL_SPECS.session_wait, ({ sessionId, timeoutMs }, request: ServerContext) =>
    run(async () => {
      assertNotOwnSession(sessionId, "wait on");
      const progressToken = request.mcpReq._meta?.progressToken;
      let ticks = 0;
      let progress: ReturnType<typeof setInterval> | null = null;
      const stopProgress = (): void => {
        if (progress) clearInterval(progress);
        progress = null;
      };
      if (progressToken !== undefined) {
        progress = setInterval(() => {
          ticks += 1;
          request.mcpReq
            .notify({ method: "notifications/progress", params: { progressToken, progress: ticks, message: `waiting for session ${sessionId}` } })
            .catch((error: unknown) => {
              if (progress === null) return;
              stopProgress();
              console.warn(`[mcp] session_wait progress stopped: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, WAIT_PROGRESS_INTERVAL_MS);
      }
      try {
        return await deps.watch.wait(sessionId, clampWait(timeoutMs), request.mcpReq.signal);
      } finally {
        stopProgress();
      }
    })
  );

  server.registerTool("usage_report", CW_TOOL_SPECS.usage_report, (query) => run(() => call("usage.report", query)));

  server.registerTool("settings_get", CW_TOOL_SPECS.settings_get, () => run(() => call("settings.get")));

  server.registerTool("settings_set", CW_TOOL_SPECS.settings_set, ({ patch }) => run(() => call("settings.set", patch)));
}
