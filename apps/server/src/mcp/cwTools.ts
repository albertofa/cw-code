import type { ComposerPrefs, PermissionMode, Project, SessionMeta, SessionStatus, SubagentResult, SubagentSummary } from "@cw-code/contracts";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { DRIVER_KINDS } from "@cw-code/shared/driverKinds";
import { z } from "zod";
import { agentTurnPermissionMode, assertAgentSessionTarget, SAFE_MODEL_ID } from "../agent/agentPolicy.js";
import { EFFORT_LEVELS } from "../agent/modelSearch.js";
import type { SessionWatch } from "../agent/SessionWatch.js";
import { PERMISSION_MODES } from "../providers/permissions.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import type { CallContext, Router } from "../transport/Router.js";

export type CwToolsSessions = Pick<SessionManager, "getComposer" | "turnPermissionMode" | "findSession">;

export interface CwToolsDeps {
  router: Router;
  watch: Pick<SessionWatch, "wait" | "lastResult">;
  sessions: CwToolsSessions;
  callerSessionId: string;
  exposeAllTools?: boolean;
}

export const WAIT_DEFAULT_MS = 120_000;
export const WAIT_MIN_MS = 1_000;
export const WAIT_MAX_MS = 240_000;
export const WAIT_PROGRESS_INTERVAL_MS = 15_000;

export const SUBAGENT_RUNNING_NEXT =
  "The subagent is still running. End your turn now; cw-code sends its result to you as a new turn when it finishes. Call subagent_wait only if you cannot continue without the result.";
export const SUBAGENT_INPUT_NEXT =
  "The subagent is waiting for the user to answer an approval or question in cw-code. Tell the user, then end your turn; cw-code sends its result to you as a new turn when it finishes.";

const HIDDEN_STATUSES: ReadonlySet<SessionMeta["status"]> = new Set(["resolved", "archived"]);
const READ_ONLY = { readOnlyHint: true } as const;
const WAIT_RANGE = `default ${WAIT_DEFAULT_MS}, ${WAIT_MIN_MS}-${WAIT_MAX_MS}`;
const SUBAGENT_RETURN =
  "Returns {subagentId, status, outcome, resultText, timedOut, next}; outcome is done, error or interrupted once the turn settled, otherwise null; when next is set, follow it.";

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
      driver: z.enum(DRIVER_KINDS),
      prompt: z.string().min(1),
      model: z.string().regex(SAFE_MODEL_ID, "not a valid model id").optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
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
    description: `Block until another session (not your own) stops working or timeoutMs passes (${WAIT_RANGE}). Returns {status, lastResultText, timedOut}; returns at once if the session is not working.`,
    inputSchema: z.object({ sessionId: z.string(), timeoutMs: z.number().int().optional() }),
    annotations: READ_ONLY
  },
  usage_report: {
    description:
      "Token and cost usage over the last `days` days. metric 'all' counts every token, 'fresh' excludes cache reads. driver and projectId accept 'all'.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(366),
      metric: z.enum(["all", "fresh"]),
      driver: z.enum([...DRIVER_KINDS, "all"]),
      projectId: z.string()
    }),
    annotations: READ_ONLY
  },
  settings_get: { description: "Read the cw-code app settings.", inputSchema: z.object({}), annotations: READ_ONLY },
  settings_set: {
    description: "Change cw-code app settings with a partial patch (only model, worktree, session lifecycle and refresh settings are writable). Returns the full settings.",
    inputSchema: z.object({ patch: z.record(z.string(), z.unknown()) })
  },
  subagent_run: {
    description: `Dispatch a subagent: a hidden cw-code session on driver (claude, codex or opencode) that runs task and reports back only to you. Use it for work on another harness or, with isolation 'worktree', in its own checkout ('shared', the default, works in your checkout). If the user named a model in plain text, call subagent_targets with that text first and pass the returned id as model. permissionMode is capped at your own. With wait (default true) blocks until the subagent finishes, needs the user, or timeoutMs passes (${WAIT_RANGE}); for long tasks pass wait: false and end your turn. Fails without creating anything when driver cannot run on this machine; report that error to the user. ${SUBAGENT_RETURN}`,
    inputSchema: z.object({
      driver: z.enum(DRIVER_KINDS),
      task: z.string().min(1),
      title: z.string().optional(),
      model: z.string().regex(SAFE_MODEL_ID, "not a valid model id").optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
      isolation: z.enum(["shared", "worktree"]).default("shared"),
      wait: z.boolean().default(true),
      timeoutMs: z.number().int().optional()
    })
  },
  subagent_wait: {
    description: `Block until one of your subagents stops working, needs the user (status 'input-required') or timeoutMs passes (${WAIT_RANGE}). Do not call it in a loop: if it times out, end your turn and cw-code sends the result as a new turn. Returns {status, outcome, resultText, timedOut, next}: outcome is done, error or interrupted once the turn settled, otherwise null; when next is set, follow it.`,
    inputSchema: z.object({ subagentId: z.string(), timeoutMs: z.number().int().optional() }),
    annotations: READ_ONLY
  },
  subagent_send: {
    description: `Send a follow-up prompt to one of your subagents that is not working, as a new turn in its own context. wait and timeoutMs work as in subagent_run. ${SUBAGENT_RETURN}`,
    inputSchema: z.object({
      subagentId: z.string(),
      prompt: z.string().min(1),
      wait: z.boolean().default(true),
      timeoutMs: z.number().int().optional()
    })
  },
  subagent_stop: {
    description: "Interrupt the running turn of one of your subagents. Returns {stopped}.",
    inputSchema: z.object({ subagentId: z.string() })
  },
  subagents_list: {
    description: "List your subagents as {id, driver, title, status, model, isolation, result, pendingRequests, createdAt, updatedAt}.",
    inputSchema: z.object({}),
    annotations: READ_ONLY
  },
  subagent_targets: {
    description:
      "List the harnesses a subagent can run on, with their models: [{driver, installed, defaultModel, models: [{id, label, variants, efforts}], effort, error}]. When the user names a model in plain text (e.g. 'opus 4.5', 'gpt 5 codex high', 'kimi'), pass that text as query: matching ids come first, a harness name in the query narrows the harnesses and an effort word comes back as effort. Use the returned id as subagent_run's model. An entry without models carries an error: when it says the harness could not run or was not found, tell the user that error instead of dispatching to that harness or guessing a model.",
    inputSchema: z.object({ driver: z.enum(DRIVER_KINDS).optional(), query: z.string().optional() }),
    annotations: READ_ONLY
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

async function withWaitProgress<T>(request: ServerContext, tool: string, subject: string, work: () => Promise<T>): Promise<T> {
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
        .notify({ method: "notifications/progress", params: { progressToken, progress: ticks, message: `waiting for ${subject}` } })
        .catch((error: unknown) => {
          if (progress === null) return;
          stopProgress();
          console.warn(`[mcp] ${tool} progress stopped: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, WAIT_PROGRESS_INTERVAL_MS);
  }
  try {
    return await work();
  } finally {
    stopProgress();
  }
}

type RouterCall = (method: string, params?: unknown) => Promise<unknown>;

interface SubagentTurn {
  subagentId: string;
  turnId: string | undefined;
}

interface SubagentReport {
  status: SessionStatus;
  outcome: SubagentResult["outcome"] | null;
  resultText: string | null;
  timedOut: boolean;
  next: string | null;
}

export function registerCwTools(server: McpServer, deps: CwToolsDeps): void {
  const ctx: CallContext = { clientId: `mcp:${deps.callerSessionId}`, client: "mcp", auth: { kind: "agent", sessionId: deps.callerSessionId } };
  const call: RouterCall = (method, params) => deps.router.dispatch(method, params, ctx);

  const listSessions = async (projectId: string | undefined): Promise<SessionMeta[]> => {
    const projectIds = projectId !== undefined ? [projectId] : ((await call("projects.list")) as Project[]).map((project) => project.id);
    const perProject = await Promise.all(projectIds.map((id) => call("sessions.list", id) as Promise<SessionMeta[]>));
    return perProject.flat().filter((session) => !session.subagent);
  };

  const assertNotOwnSession = (sessionId: string, action: string): void => {
    if (sessionId === deps.callerSessionId) throw new Error(`an agent cannot ${action} its own session`);
  };

  const findSession = (sessionId: string): SessionMeta | undefined => deps.sessions.findSession(sessionId);
  const dispatches = deps.exposeAllTools === true || !findSession(deps.callerSessionId)?.subagent;

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

  if (dispatches) {
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
  }

  server.registerTool("session_wait", CW_TOOL_SPECS.session_wait, ({ sessionId, timeoutMs }, request: ServerContext) =>
    run(async () => {
      assertNotOwnSession(sessionId, "wait on");
      assertAgentSessionTarget(findSession, sessionId, deps.callerSessionId);
      return withWaitProgress(request, "session_wait", `session ${sessionId}`, () =>
        deps.watch.wait(sessionId, clampWait(timeoutMs), request.mcpReq.signal)
      );
    })
  );

  server.registerTool("usage_report", CW_TOOL_SPECS.usage_report, (query) => run(() => call("usage.report", query)));

  server.registerTool("settings_get", CW_TOOL_SPECS.settings_get, () => run(() => call("settings.get")));

  server.registerTool("settings_set", CW_TOOL_SPECS.settings_set, ({ patch }) => run(() => call("settings.set", patch)));

  if (dispatches) registerSubagentTools(server, deps, call);
}

function registerSubagentTools(server: McpServer, deps: CwToolsDeps, call: RouterCall): void {
  const ownSubagent = async (subagentId: string): Promise<SubagentSummary> => {
    const child = ((await call("subagents.list")) as SubagentSummary[]).find((summary) => summary.id === subagentId);
    if (!child) throw new Error(`unknown subagent ${subagentId}`);
    return child;
  };

  const report = async (turn: SubagentTurn, timedOut: boolean, signal: AbortSignal): Promise<SubagentReport> => {
    const child = await ownSubagent(turn.subagentId);
    if (child.status === "input-required" || child.pendingRequests > 0) {
      return { status: "input-required", outcome: null, resultText: null, timedOut, next: SUBAGENT_INPUT_NEXT };
    }
    if (child.status === "working") return { status: child.status, outcome: null, resultText: null, timedOut, next: SUBAGENT_RUNNING_NEXT };
    const result = child.result;
    if (!result || (turn.turnId !== undefined && result.turnId !== turn.turnId)) {
      return { status: child.status, outcome: null, resultText: null, timedOut, next: null };
    }
    if (!signal.aborted) await call("subagents.ack", { subagentId: turn.subagentId, turnId: result.turnId });
    return { status: child.status, outcome: result.outcome, resultText: result.text, timedOut, next: null };
  };

  const settle = async (tool: string, turn: SubagentTurn, wait: boolean, timeoutMs: number | undefined, request: ServerContext): Promise<SubagentReport> => {
    const { signal } = request.mcpReq;
    if (!wait) return report(turn, false, signal);
    const waited = await withWaitProgress(request, tool, `subagent ${turn.subagentId}`, () => deps.watch.wait(turn.subagentId, clampWait(timeoutMs), signal));
    return report(turn, waited.timedOut, signal);
  };

  server.registerTool(
    "subagent_run",
    CW_TOOL_SPECS.subagent_run,
    ({ driver, task, title, model, effort, permissionMode, isolation, wait, timeoutMs }, request: ServerContext) =>
      run(async () => {
        const created = (await call("subagents.create", { driver, task, title, model, effort, permissionMode, isolation })) as { subagentId: string; turnId: string };
        return { subagentId: created.subagentId, ...(await settle("subagent_run", created, wait, timeoutMs, request)) };
      })
  );

  server.registerTool("subagent_wait", CW_TOOL_SPECS.subagent_wait, ({ subagentId, timeoutMs }, request: ServerContext) =>
    run(async () => {
      await ownSubagent(subagentId);
      return settle("subagent_wait", { subagentId, turnId: undefined }, true, timeoutMs, request);
    })
  );

  server.registerTool("subagent_send", CW_TOOL_SPECS.subagent_send, ({ subagentId, prompt, wait, timeoutMs }, request: ServerContext) =>
    run(async () => {
      const { turnId } = (await call("subagents.send", { subagentId, prompt })) as { turnId: string };
      return { subagentId, ...(await settle("subagent_send", { subagentId, turnId }, wait, timeoutMs, request)) };
    })
  );

  server.registerTool("subagent_stop", CW_TOOL_SPECS.subagent_stop, ({ subagentId }) => run(() => call("subagents.stop", { subagentId })));

  server.registerTool("subagents_list", CW_TOOL_SPECS.subagents_list, () => run(() => call("subagents.list")));

  server.registerTool("subagent_targets", CW_TOOL_SPECS.subagent_targets, ({ driver, query }) => run(() => call("subagents.targets", { driver, query })));
}
