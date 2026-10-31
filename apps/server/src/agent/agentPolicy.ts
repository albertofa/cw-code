import type { AppSettings, PermissionMode, SessionMeta, SettingsPatch } from "@cw-code/contracts";
import { PERMISSION_MODES } from "../providers/permissions.js";
import type { CallContext } from "../transport/Router.js";

export const AGENT_METHODS: ReadonlySet<string> = new Set([
  "projects.list",
  "sessions.list",
  "sessions.create",
  "turns.start",
  "turns.stop",
  "composer.get",
  "usage.report",
  "settings.get",
  "settings.set",
  "subagents.ack",
  "subagents.create",
  "subagents.list",
  "subagents.send",
  "subagents.stop",
  "subagents.targets"
]);

export const SUBAGENT_DEPTH_REFUSAL = "subagents cannot dispatch subagents; complete this task yourself";

export const AGENT_WRITABLE_SETTINGS: ReadonlySet<keyof AppSettings> = new Set<keyof AppSettings>([
  "claudeDefaultModel",
  "codexDefaultModel",
  "opencodeDefaultModel",
  "claudeEnabledModels",
  "claudeReasoningExpanded",
  "opencodeReasoningExpanded",
  "codexReasoningExpanded",
  "defaultUseWorktree",
  "prFinishedSessionStatus",
  "idleResolveAfterDays",
  "holdingAutoExpireEnabled",
  "holdingHours",
  "sourceControlRefreshIntervalSeconds",
  "prRefreshIntervalSeconds"
]);

export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]+\-]{0,127}$/;

const AGENT_MODEL_SETTINGS = ["claudeDefaultModel", "codexDefaultModel", "opencodeDefaultModel"] as const;

export function capPermissionMode(requested: PermissionMode | undefined, callerMode: PermissionMode | undefined): PermissionMode {
  const cap = callerMode ?? "manual";
  if (requested === undefined) return cap;
  return PERMISSION_MODES.indexOf(requested) < PERMISSION_MODES.indexOf(cap) ? requested : cap;
}

export interface PermissionModeSource {
  getComposer(sessionId: string): { permissionMode?: PermissionMode };
  turnPermissionMode(sessionId: string): PermissionMode | undefined;
}

export function callerPermissionCap(sessions: PermissionModeSource, callerSessionId: string): PermissionMode {
  return capPermissionMode(sessions.turnPermissionMode(callerSessionId), sessions.getComposer(callerSessionId).permissionMode);
}

export function agentTurnPermissionMode(
  sessions: PermissionModeSource,
  targetSessionId: string,
  callerSessionId: string,
  requested: PermissionMode | undefined
): PermissionMode {
  const target = requested ?? sessions.getComposer(targetSessionId).permissionMode;
  return capPermissionMode(target, callerPermissionCap(sessions, callerSessionId));
}

function forbidden(message: string): Error {
  return Object.assign(new Error(message), { code: "forbidden" });
}

export function isSafeModelId(value: unknown): value is string {
  return typeof value === "string" && SAFE_MODEL_ID.test(value);
}

export function assertAgentModelId(value: unknown, field: string): void {
  if (value !== undefined && !isSafeModelId(value)) throw forbidden(`${field} is not a valid model id`);
}

function isSafeModelSetting(value: unknown): boolean {
  return typeof value === "string" && (value.trim() === "" || isSafeModelId(value.trim()));
}

export function assertAgentSettingsPatch(patch: SettingsPatch): void {
  const denied = Object.keys(patch).find((key) => !AGENT_WRITABLE_SETTINGS.has(key as keyof AppSettings));
  if (denied !== undefined) throw forbidden(`changing ${denied} is not available to agents`);
  for (const key of AGENT_MODEL_SETTINGS) {
    const value: unknown = patch[key];
    if (value !== undefined && !isSafeModelSetting(value)) throw forbidden(`${key} is not a valid model id`);
  }
  const enabled: unknown = patch.claudeEnabledModels;
  if (enabled !== undefined && !(Array.isArray(enabled) && enabled.every(isSafeModelSetting))) {
    throw forbidden("claudeEnabledModels must be a list of valid model ids");
  }
}

export function assertAgentOmits(args: object, fields: readonly string[], method: string): void {
  const denied = fields.find((field) => Reflect.get(args, field) !== undefined);
  if (denied !== undefined) throw forbidden(`${method} ${denied} is not available to agents`);
}

export type SessionLookup = (sessionId: string) => SessionMeta | undefined;

export function subagentDepthError(): Error {
  return forbidden(SUBAGENT_DEPTH_REFUSAL);
}

export function assertCanDispatchSubagents(caller: Pick<SessionMeta, "subagent"> | undefined): void {
  if (caller?.subagent) throw subagentDepthError();
}

export function assertAgentMayDispatch(ctx: CallContext, findSession: SessionLookup): void {
  if (ctx.auth.kind === "agent") assertCanDispatchSubagents(findSession(ctx.auth.sessionId));
}

export function assertAgentSessionTarget(findSession: SessionLookup, sessionId: string, callerSessionId: string): void {
  const parentId = findSession(sessionId)?.subagent?.parentSessionId;
  if (parentId === undefined) return;
  if (parentId === callerSessionId) throw new Error(`session ${sessionId} is your subagent; use subagent_send, subagent_wait or subagent_stop for it`);
  throw new Error(`unknown session ${sessionId}`);
}

export function ownedSubagent(child: SessionMeta | undefined, childId: string, callerSessionId: string | null): SessionMeta {
  const parentId = child?.subagent?.parentSessionId;
  if (!child || parentId === undefined || (callerSessionId !== null && parentId !== callerSessionId)) throw new Error(`unknown subagent ${childId}`);
  return child;
}

export function assertAgentCreateOptions(options: unknown): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object") throw forbidden("sessions.create options must be an object");
  const denied = Object.keys(options).find((key) => key !== "useWorktree");
  if (denied !== undefined) throw forbidden(`sessions.create option ${denied} is not available to agents`);
}
