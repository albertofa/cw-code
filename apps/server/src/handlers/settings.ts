import type { SettingsPatch } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { CliVersionCheck } from "@cw-code/contracts";
import { checkCliVersion } from "../cliVersions.js";
import { defaultPrWorkflows } from "../settings/prWorkflowDefaults.js";
import { configuredCliBinaryPath } from "../settings/settingsUtils.js";
import type { Router } from "../transport/Router.js";
import { handle, requireOwner } from "./shared.js";

export function registerSettingsHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  handle(router, "settings.get", () => services().sessions.getSettings());
  handle(router, "settings.prWorkflowDefaults", () => defaultPrWorkflows());
  handle<SettingsPatch>(router, "settings.set", async (patch, ctx) => {
    if (patch.serverBindHost !== undefined) requireOwner(ctx, "changing serverBindHost");
    const { sessions, accountUsage, appTopic, harnessMonitor } = services();
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
    const saved = sessions.setSettings(normalized);
    appTopic.setSettings(saved);
    services().prStore.onSettingsChanged();
    services().autoFollowUp.reevaluate();
    services().sidebar.invalidate();
    app.emit("settings.changed", saved);
    if (checks.length > 0) void harnessMonitor.check("settings");
    return saved;
  });
}
