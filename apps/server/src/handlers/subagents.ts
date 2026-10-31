import type { DriverKind, EffortLevel, ModelOption, SessionMeta, SubagentIsolation } from "@cw-code/contracts";
import {
  agentTurnPermissionMode,
  assertAgentMayDispatch,
  assertAgentModelId,
  assertCanDispatchSubagents,
  callerPermissionCap,
  capPermissionMode,
  ownedSubagent
} from "../agent/agentPolicy.js";
import { EFFORT_LEVELS, parseModelQuery, rankModelMatches } from "../agent/modelSearch.js";
import { subagentSummary } from "../agent/subagentSummary.js";
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

function subagentTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function titleFor(title: string | undefined, task: string): string {
  const explicit = title === undefined ? "" : subagentTitle(title);
  return explicit || subagentTitle(task.split("\n").find((line) => line.trim()) ?? task);
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const models = await sessions.listModelsFor(projectId, driver).catch((error: unknown) => {
    console.warn(`[subagents] ${driver} model list for project ${projectId} failed: ${errorText(error)}`);
    return [];
  });
  return models.length > 0 ? models : sessions.listModelsForHarness(driver);
}

async function listTargets(
  services: Services,
  caller: SessionMeta,
  drivers: readonly DriverKind[],
  query: string | undefined,
  effort: EffortLevel | undefined
): Promise<SubagentTarget[]> {
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
        ...(effort !== undefined ? { effort } : {})
      };
      if (!base.installed) return { ...base, models: [] };
      try {
        const models = await harnessModels(services.sessions, caller.projectId, kind);
        const matched = query ? rankModelMatches(models, query) : models;
        return { ...base, models: matched.map((model) => targetModel(kind, model)) };
      } catch (error) {
        return { ...base, models: [], error: errorText(error) };
      }
    })
  );
}

async function searchTargets(services: Services, caller: SessionMeta, driver: DriverKind | undefined, query: string | undefined): Promise<SubagentTarget[]> {
  const parsed = query ? parseModelQuery(query) : null;
  if (driver) return listTargets(services, caller, [driver], query, parsed?.effort);
  if (!parsed || parsed.harnesses.length === 0) return listTargets(services, caller, DRIVER_KINDS, query, parsed?.effort);
  const narrowed = await listTargets(services, caller, DRIVER_KINDS.filter((kind) => parsed.harnesses.includes(kind)), query, parsed.effort);
  if (narrowed.some((target) => target.models.length > 0)) return narrowed;
  return listTargets(services, caller, DRIVER_KINDS, query, parsed.effort);
}

async function archiveUnstartedSubagent(sessions: Services["sessions"], child: SessionMeta, isolation: SubagentIsolation): Promise<void> {
  try {
    await sessions.resolveSession(child.id, "archived", { removeWorktree: isolation === "worktree" });
  } catch (error) {
    console.warn(`[subagents] could not archive ${child.id} after its first turn failed to start: ${errorText(error)}`);
  }
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
    const title = titleFor(parseOptionalString(args.title, "title"), task);
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
      await archiveUnstartedSubagent(sessions, child, isolation);
      throw new Error(`subagent ${child.id} was created but its first turn did not start: ${errorText(error)}`);
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

  handle<unknown>(router, "subagents.ack", (value, ctx) => {
    const callerId = agentCaller(ctx, "subagents.ack");
    const { sessions } = services();
    dispatchingCaller(sessions, callerId);
    const args = parseArgs(value, "subagents.ack");
    const subagentId = parseString(args.subagentId, "subagentId");
    const turnId = parseString(args.turnId, "turnId");
    const child = ownedSubagent(sessions.findSession(subagentId), subagentId, callerId);
    const callerInTurn = sessions.listActiveTurns().some((turn) => turn.sessionId === callerId);
    if (!callerInTurn || child.subagent?.result?.turnId !== turnId) return { delivered: false };
    sessions.markSubagentDelivered(child.id, turnId);
    return { delivered: true };
  });

  handle<unknown>(router, "subagents.list", (value, ctx) => {
    const { sessions } = services();
    const parentId =
      ctx.auth.kind === "agent" ? ctx.auth.sessionId : knownSessionId(sessions, parseArgs(value, "subagents.list").parentSessionId);
    return sessions.listSubagents(parentId).map((child) => subagentSummary(child, sessions.listPendingRequests(child.id).length));
  });

  handle<unknown>(router, "subagents.stop", (value, ctx) => {
    const { sessions, turns } = services();
    assertAgentMayDispatch(ctx, (id) => sessions.findSession(id));
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
    return searchTargets(all, caller, driver, query);
  });
}
