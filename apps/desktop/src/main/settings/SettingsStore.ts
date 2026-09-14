import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, SettingsPatch } from "@cw-code/contracts";
import { CLAUDE_CURATED_MODELS } from "../providers/claude/ClaudeCliDriver.js";
import {
  configuredCliBinaryPath,
  defaultCliBinaryPath,
  normalizeBinaryPath
} from "./settingsUtils.js";

export const DEFAULT_SETTINGS: AppSettings = {
  claudeBinaryPath: defaultCliBinaryPath("claude"),
  opencodeBinaryPath: defaultCliBinaryPath("opencode"),
  codexBinaryPath: defaultCliBinaryPath("codex"),
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: "",
  claudeDefaultModel: "",
  claudeEnabledModels: CLAUDE_CURATED_MODELS.map((m) => m.id),
  claudeCustomModel: { id: "", name: "" },
  gitBinaryPath: defaultCliBinaryPath("git"),
  githubCliBinaryPath: defaultCliBinaryPath("gh"),
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low"
};

function sanitize(patch: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (patch.claudeBinaryPath !== undefined) {
    out.claudeBinaryPath = configuredCliBinaryPath("claude", patch.claudeBinaryPath);
  }
  if (patch.opencodeBinaryPath !== undefined) {
    out.opencodeBinaryPath = normalizeBinaryPath(patch.opencodeBinaryPath) || DEFAULT_SETTINGS.opencodeBinaryPath;
  }
  if (patch.codexBinaryPath !== undefined) {
    out.codexBinaryPath = normalizeBinaryPath(patch.codexBinaryPath) || DEFAULT_SETTINGS.codexBinaryPath;
  }
  if (patch.claudeExtraArgs !== undefined) out.claudeExtraArgs = patch.claudeExtraArgs.trim();
  if (patch.opencodeExtraArgs !== undefined) out.opencodeExtraArgs = patch.opencodeExtraArgs.trim();
  if (patch.codexExtraArgs !== undefined) out.codexExtraArgs = patch.codexExtraArgs.trim();
  if (patch.claudeDefaultModel !== undefined) out.claudeDefaultModel = patch.claudeDefaultModel.trim();
  if (patch.claudeCustomModel !== undefined) {
    const raw: unknown = patch.claudeCustomModel;
    if (typeof raw === "string") {
      out.claudeCustomModel = { id: raw.trim(), name: "" };
    } else if (raw && typeof raw === "object") {
      const o = raw as { id?: unknown; name?: unknown };
      out.claudeCustomModel = {
        id: typeof o.id === "string" ? o.id.trim() : "",
        name: typeof o.name === "string" ? o.name.trim() : ""
      };
    }
  }
  if (patch.claudeEnabledModels !== undefined) {
    out.claudeEnabledModels = patch.claudeEnabledModels.map((id) => id.trim()).filter(Boolean);
  }
  if (patch.gitBinaryPath !== undefined) {
    out.gitBinaryPath = normalizeBinaryPath(patch.gitBinaryPath) || DEFAULT_SETTINGS.gitBinaryPath;
  }
  if (patch.githubCliBinaryPath !== undefined) {
    out.githubCliBinaryPath = normalizeBinaryPath(patch.githubCliBinaryPath) || DEFAULT_SETTINGS.githubCliBinaryPath;
  }
  if (patch.sourceControlRefreshIntervalSeconds !== undefined) {
    const value = Math.round(Number(patch.sourceControlRefreshIntervalSeconds));
    out.sourceControlRefreshIntervalSeconds = Number.isFinite(value) ? Math.min(3600, Math.max(5, value)) : 30;
  }
  if (patch.defaultUseWorktree !== undefined) out.defaultUseWorktree = patch.defaultUseWorktree === true;
  if (patch.autoTitleEnabled !== undefined) out.autoTitleEnabled = patch.autoTitleEnabled === true;
  if (patch.autoTitleDriver !== undefined) {
    out.autoTitleDriver =
      patch.autoTitleDriver === "claude" || patch.autoTitleDriver === "opencode" || patch.autoTitleDriver === "codex"
        ? patch.autoTitleDriver
        : DEFAULT_SETTINGS.autoTitleDriver;
  }
  if (patch.autoTitleModel !== undefined) out.autoTitleModel = patch.autoTitleModel.trim();
  if (patch.autoTitleEffort !== undefined) {
    out.autoTitleEffort =
      patch.autoTitleEffort === "minimal" || patch.autoTitleEffort === "low" || patch.autoTitleEffort === "medium" || patch.autoTitleEffort === "high" || patch.autoTitleEffort === "xhigh" || patch.autoTitleEffort === "max"
        ? patch.autoTitleEffort
        : DEFAULT_SETTINGS.autoTitleEffort;
  }
  return out;
}

function defaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    claudeEnabledModels: [...DEFAULT_SETTINGS.claudeEnabledModels],
    claudeCustomModel: { ...DEFAULT_SETTINGS.claudeCustomModel }
  };
}

function load(filePath: string): { data: AppSettings; persist: boolean } {
  const data = defaults();
  if (!existsSync(filePath)) return { data, persist: true };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AppSettings>;
    const loaded = { ...data, ...sanitize(parsed) };
    return { data: loaded, persist: JSON.stringify(parsed) !== JSON.stringify(loaded) };
  } catch {
    return { data, persist: true };
  }
}

export class SettingsStore {
  private filePath: string;
  private data: AppSettings;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const loaded = load(this.filePath);
    this.data = loaded.data;
    if (loaded.persist) this.persist();
  }

  get(): AppSettings {
    return { ...this.data, claudeEnabledModels: [...this.data.claudeEnabledModels] };
  }

  set(patch: SettingsPatch): AppSettings {
    this.data = { ...this.data, ...sanitize(patch) };
    this.persist();
    return this.get();
  }

  private persist(): void {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.filePath);
  }
}
