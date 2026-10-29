import type { AppSettings, PermissionMode, SettingsPatch } from "@cw-code/contracts";

export const AGENT_METHODS: ReadonlySet<string> = new Set([
  "projects.list",
  "sessions.list",
  "sessions.create",
  "turns.start",
  "turns.stop",
  "composer.get",
  "models.listFor",
  "usage.report",
  "settings.get",
  "settings.set"
]);

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

const PERMISSION_RANK: Record<PermissionMode, number> = {
  manual: 0,
  acceptEdits: 1,
  auto: 2,
  bypassPermissions: 3
};

export function capPermissionMode(requested: PermissionMode | undefined, callerMode: PermissionMode | undefined): PermissionMode {
  const cap = callerMode ?? "manual";
  if (requested === undefined) return cap;
  return PERMISSION_RANK[requested] < PERMISSION_RANK[cap] ? requested : cap;
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

export function assertAgentSettingsPatch(patch: SettingsPatch): void {
  const denied = Object.keys(patch).find((key) => !AGENT_WRITABLE_SETTINGS.has(key as keyof AppSettings));
  if (denied !== undefined) throw forbidden(`changing ${denied} is not available to agents`);
}

export function assertAgentOmits(args: object, fields: readonly string[], method: string): void {
  const denied = fields.find((field) => Reflect.get(args, field) !== undefined);
  if (denied !== undefined) throw forbidden(`${method} ${denied} is not available to agents`);
}

export function assertAgentCreateOptions(options: unknown): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object") throw forbidden("sessions.create options must be an object");
  const denied = Object.keys(options).find((key) => key !== "useWorktree");
  if (denied !== undefined) throw forbidden(`sessions.create option ${denied} is not available to agents`);
}
