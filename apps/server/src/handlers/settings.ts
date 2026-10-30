import type { AppSettings, SettingsPatch } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { CliVersionCheck } from "@cw-code/contracts";
import { checkCliVersion } from "../cliVersions.js";
import { defaultPrWorkflows } from "../settings/prWorkflowDefaults.js";
import { bindHostOr, DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { configuredCliBinaryPath } from "../settings/settingsUtils.js";
import { assertAgentSettingsPatch } from "../agent/agentPolicy.js";
import { bindRefusal, DEFAULT_BIND_HOST } from "../transport/bindPolicy.js";
import type { Router } from "../transport/Router.js";
import { handle, requireOwner } from "./shared.js";

const OWNER_ONLY_SETTINGS = ["serverBindHost", "serverPublicUrl", "keepServerRunning"] as const satisfies ReadonlyArray<
  keyof SettingsPatch
>;

function assertBindHostAllowed(app: ServerApp, value: unknown): void {
  const host = bindHostOr(value, DEFAULT_SETTINGS.serverBindHost) || DEFAULT_BIND_HOST;
  if (!bindRefusal(host, app.devices.count())) return;
  throw Object.assign(new Error(`Pair a device before binding the server to ${host}; without a device token the server would not listen there.`), {
    code: "bind-refused"
  });
}

export function commitSettings(app: ServerApp, patch: SettingsPatch): AppSettings {
  const { sessions, appTopic, prStore, autoFollowUp, sidebar, githubViews } = app.requireServices();
  const saved = sessions.setSettings(patch);
  appTopic.setSettings(saved);
  prStore.onSettingsChanged();
  autoFollowUp.reevaluate();
  sidebar.invalidate();
  githubViews.onSettingsChanged();
  app.emit("settings.changed", saved);
  return saved;
}

export function registerSettingsHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "settings.get", () => services().sessions.getSettings());
  handle(router, "settings.prWorkflowDefaults", () => defaultPrWorkflows());
  handle<SettingsPatch>(router, "settings.set", async (patch, ctx) => {
    if (ctx.auth.kind === "agent") assertAgentSettingsPatch(patch);
    for (const key of OWNER_ONLY_SETTINGS) {
      if (patch[key] !== undefined) requireOwner(ctx, `changing ${key}`);
    }
    if (patch.serverBindHost !== undefined) assertBindHostAllowed(app, patch.serverBindHost);
    const { sessions, accountUsage, harnessMonitor, harnessUpdates } = services();
    const current = sessions.getSettings();
    const normalized = { ...patch };
    const checks: Array<Promise<CliVersionCheck>> = [];
    if (patch.claudeBinaryPath !== undefined) {
      normalized.claudeBinaryPath = configuredCliBinaryPath("claude", patch.claudeBinaryPath);
      if (normalized.claudeBinaryPath !== current.claudeBinaryPath) {
        checks.push(checkCliVersion("claude", normalized.claudeBinaryPath));
      }
    }
    if (patch.opencodeBinaryPath !== undefined) {
      normalized.opencodeBinaryPath = configuredCliBinaryPath("opencode", patch.opencodeBinaryPath);
      if (normalized.opencodeBinaryPath !== current.opencodeBinaryPath) {
        checks.push(checkCliVersion("opencode", normalized.opencodeBinaryPath));
      }
    }
    if (patch.codexBinaryPath !== undefined) {
      normalized.codexBinaryPath = configuredCliBinaryPath("codex", patch.codexBinaryPath);
      if (normalized.codexBinaryPath !== current.codexBinaryPath) {
        checks.push(checkCliVersion("codex", normalized.codexBinaryPath));
      }
    }
    const failed = (await Promise.all(checks)).find(
      (check) => (check.configured || check.found) && (check.error !== null || !check.ok)
    );
    if (failed) {
      const name = failed.binary === "claude" ? "Claude" : failed.binary === "codex" ? "Codex" : "OpenCode";
      const reason = !failed.available
        ? "Choose a valid executable name or full path."
        : failed.error !== null
          ? "The executable did not complete '--version' successfully."
          : `It reported version ${failed.actual ?? "unknown"} but needs >= ${failed.minimum}. Update the CLI to use it.`;
      throw new Error(`${name} CLI could not be verified at '${failed.binaryPath}'. ${reason}`);
    }
    if (patch.opencodeGoUsage !== undefined) accountUsage.invalidate("opencode");
    const saved = commitSettings(app, normalized);
    if (checks.length > 0) void harnessMonitor.check("settings");
    if (saved.harnessUpdateChecks !== current.harnessUpdateChecks) void harnessUpdates.refresh({ fresh: true });
    return saved;
  });
}
