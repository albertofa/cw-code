import type { DriverKind, EffortLevel, ModelOption, SessionMeta, SubagentIsolation, SubagentSummary } from "@cw-code/contracts";
import {
  agentTurnPermissionMode,
  assertAgentModelId,
  assertCanDispatchSubagents,
  callerPermissionCap,
  capPermissionMode,
  ownedSubagent
} from "../agent/agentPolicy.js";
import { EFFORT_LEVELS, parseModelQuery, rankModelMatches } from "../agent/modelSearch.js";
import type { ServerApp } from "../app/ServerApp.js";
import type { Services } from "../app/services.js";
import { effortOptionsFor } from "../prEngine/workflowHarness.js";
import { DRIVER_KINDS } from "../prefs/PreferencesStore.js";
import { PERMISSION_MODES } from "../providers/permissions.js";
import type { CallContext, Router } from "../transport/Router.js";
import { handle, knownSessionId, parseArgs, parseOptionalString, parseString, setComposer } from "./shared.js";

const ISOLATIONS: readonly SubagentIsolation[] = ["shared", "worktree"];
const TITLE_MAX = 60;

export interface SubagentTargetModel {
  id: string;
  label: string;
  variants?: string[];
  efforts?: EffortLevel[];
}

export interface SubagentTarget {
  driver: DriverKind;
  installed: boolean;
  defaultModel: string | null;
  models: SubagentTargetModel[];
  effort?: EffortLevel;
  error?: string;
}

export function subagentSummary(child: SessionMeta, pendingRequests: number): SubagentSummary {
  return {
    id: child.id,
    driver: child.driver,
    title: child.title,
    status: child.status,
    ...(child.model ? { model: child.model } : {}),
    isolation: child.subagent?.isolation ?? "shared",
    ...(child.subagent?.result ? { result: child.subagent.result } : {}),
    pendingRequests,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt
  };
}

function parseOneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return match;
}

function parseText(value: unknown, name: string): string {
  const text = parseString(value, name).trim();
  if (!text) throw new Error(`${name} must not be empty`);
  return text;
}

function defaultTitle(task: string): string {
  const line = task.split("\n").find((candidate) => candidate.trim())?.trim().replace(/\s+/g, " ") ?? task;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function agentCaller(ctx: CallContext, method: string): string {
  if (ctx.auth.kind !== "agent") throw Object.assign(new Error(`${method} is only available to agents`), { code: "forbidden" });
  return ctx.auth.sessionId;
}

function dispatchingCaller(sessions: Services["sessions"], callerId: string): SessionMeta {
  const caller = sessions.findSession(callerId);
  if (!caller) throw new Error(`unknown session ${callerId}`);
  assertCanDispatchSubagents(caller);
  return caller;
}

function targetModel(driver: DriverKind, model: ModelOption): SubagentTargetModel {
  const efforts = driver === "opencode" && model.variants !== undefined ? effortOptionsFor(driver, [model], model.id).map((option) => option.id) : undefined;
  return {
    id: model.id,
    label: model.label,
    ...(model.variants !== undefined ? { variants: model.variants } : {}),
    ...(efforts !== undefined ? { efforts } : {})
  };
}

async function harnessModels(sessions: Services["sessions"], projectId: string, driver: DriverKind): Promise<ModelOption[]> {
  const models = await sessions.listModelsFor(projectId, driver).catch(() => []);
  return models.length > 0 ? models : sessions.listModelsForHarness(driver);
}

async function listTargets(services: Services, caller: SessionMeta, driver: DriverKind | undefined, query: string | undefined): Promise<SubagentTarget[]> {
  const parsed = query ? parseModelQuery(query) : null;
  const drivers = driver ? [driver] : parsed && parsed.harnesses.length > 0 ? DRIVER_KINDS.filter((kind) => parsed.harnesses.includes(kind)) : DRIVER_KINDS;
  const { installed } = services.appTopic.harnesses;
  const settings = services.sessions.getSettings();
  const defaults: Record<DriverKind, string> = {
    claude: settings.claudeDefaultModel,
    codex: settings.codexDefaultModel,
    opencode: settings.opencodeDefaultModel
  };
  return Promise.all(
    drivers.map(async (kind): Promise<SubagentTarget> => {
      const base = {
        driver: kind,
        installed: installed.length === 0 || installed.includes(kind),
        defaultModel: defaults[kind].trim() || null,
        ...(parsed?.effort !== undefined ? { effort: parsed.effort } : {})
      };
      if (!base.installed) return { ...base, models: [] };
      try {
        const models = await harnessModels(services.sessions, caller.projectId, kind);
        const matched = query ? rankModelMatches(models, query) : models;
        return { ...base, models: matched.map((model) => targetModel(kind, model)) };
      } catch (error) {
        return { ...base, models: [], error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}

export function registerSubagentHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();

  handle<unknown>(router, "subagents.create", async (value, ctx) => {
    const callerId = agentCaller(ctx, "subagents.create");
    const { sessions, turns } = services();
    dispatchingCaller(sessions, callerId);
    const args = parseArgs(value, "subagents.create");
    const driver = parseOneOf(args.driver, DRIVER_KINDS, "driver");
    if (driver === undefined) throw new Error("driver is required");
    const task = parseText(args.task, "task");
    const title = parseOptionalString(args.title, "title")?.trim() || defaultTitle(task);
    assertAgentModelId(args.model, "subagents.create model");
    const model = parseOptionalString(args.model, "model");
    const effort = parseOneOf(args.effort, EFFORT_LEVELS, "effort");
    const requested = parseOneOf(args.permissionMode, PERMISSION_MODES, "permissionMode");
    const isolation = parseOneOf(args.isolation, ISOLATIONS, "isolation") ?? "shared";
    const stored = capPermissionMode(requested, callerPermissionCap(sessions, callerId));
    const child = await sessions.createSubagentSession(callerId, driver, { title, isolation });
    setComposer(app, child.id, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: stored });
    const permissionMode = agentTurnPermissionMode(sessions, child.id, callerId, requested);
    let turnId: string;
    try {
      turnId = await turns.start(child.id, task, { prefs: { ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode } });
    } catch (error) {
      throw new Error(`subagent ${child.id} was created but its first turn did not start: ${(error as Error).message}`);
    }
    return { subagentId: child.id, turnId, permissionMode };
  });

  handle<unknown>(router, "subagents.send", async (value, ctx) => {
    const callerId = agentCaller(ctx, "subagents.send");
    const { sessions, turns } = services();
    dispatchingCaller(sessions, callerId);
    const args = parseArgs(value, "subagents.send");
    const subagentId = parseString(args.subagentId, "subagentId");
    const prompt = parseText(args.prompt, "prompt");
    const child = ownedSubagent(sessions.findSession(subagentId), subagentId, callerId);
    const permissionMode = agentTurnPermissionMode(sessions, child.id, callerId, undefined);
    return { turnId: await turns.start(child.id, prompt, { prefs: { permissionMode } }) };
  });

  handle<unknown>(router, "subagents.list", (value, ctx) => {
    const { sessions } = services();
    const parentId =
      ctx.auth.kind === "agent" ? ctx.auth.sessionId : knownSessionId(sessions, parseArgs(value, "subagents.list").parentSessionId);
    return sessions.listSubagents(parentId).map((child) => subagentSummary(child, sessions.listPendingRequests(child.id).length));
  });

  handle<unknown>(router, "subagents.stop", (value, ctx) => {
    const { sessions, turns } = services();
    const subagentId = parseString(parseArgs(value, "subagents.stop").subagentId, "subagentId");
    const child = ownedSubagent(sessions.findSession(subagentId), subagentId, ctx.auth.kind === "agent" ? ctx.auth.sessionId : null);
    return turns.stop(child.id);
  });

  handle<unknown>(router, "subagents.targets", (value, ctx) => {
    const callerId = agentCaller(ctx, "subagents.targets");
    const all = services();
    const caller = dispatchingCaller(all.sessions, callerId);
    const args = value === undefined ? {} : parseArgs(value, "subagents.targets");
    const driver = parseOneOf(args.driver, DRIVER_KINDS, "driver");
    const query = parseOptionalString(args.query, "query")?.trim() || undefined;
    return listTargets(all, caller, driver, query);
  });
}
