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
  "autoTitleEnabled",
  "autoTitleDriver",
  "autoTitleModel",
  "autoTitleEffort",
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

export function assertAgentSettingsPatch(patch: SettingsPatch): void {
  const denied = Object.keys(patch).find((key) => !AGENT_WRITABLE_SETTINGS.has(key as keyof AppSettings));
  if (denied !== undefined) {
    throw Object.assign(new Error(`changing ${denied} is not available to agents`), { code: "forbidden" });
  }
}
