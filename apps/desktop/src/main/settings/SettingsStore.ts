import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, PrSuggestCondition, PrWorkflow, PrWorkflowIcon, PrWorkspaceChoice, SettingsPatch } from "@cw-code/contracts";
import { CLAUDE_CURATED_MODELS } from "../providers/claude/ClaudeCliDriver.js";
import { writeFileAtomic } from "../storage/atomicFile.js";
import {
  isMetadataDocument,
  loadVersionedJson,
  type MetadataDocument,
  type MetadataMigration,
  type MetadataSchema
} from "../storage/versionedJson.js";
import { defaultPrWorkflows } from "./prWorkflowDefaults.js";
import {
  configuredCliBinaryPath,
  defaultCliBinaryPath,
  normalizeBinaryPath
} from "./settingsUtils.js";

const VALID_PR_ICONS: readonly PrWorkflowIcon[] = ["eye", "activity", "message", "wrench", "merge", "bot", "sparkle"];
const VALID_PR_CONDITIONS: readonly PrSuggestCondition[] = [
  "review-requested",
  "author",
  "checks-failing",
  "changes-requested",
  "conflicts",
  "bot-author",
  "draft"
];
const VALID_PR_WORKSPACES: readonly PrWorkspaceChoice[] = ["checkout", "worktree", "linked"];

function sanitizeWorkflowEntry(entry: unknown): PrWorkflow | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  if (typeof o.label !== "string" || typeof o.description !== "string") return null;
  if (typeof o.startPrompt !== "string" || typeof o.updatePrompt !== "string") return null;
  if (!VALID_PR_ICONS.includes(o.icon as PrWorkflowIcon)) return null;
  if (!VALID_PR_WORKSPACES.includes(o.workspace as PrWorkspaceChoice)) return null;
  if (!Array.isArray(o.suggestWhen)) return null;
  return {
    id,
    label: o.label.trim(),
    description: o.description.trim(),
    icon: o.icon as PrWorkflowIcon,
    builtIn: o.builtIn === true,
    enabled: o.enabled === true,
    suggestWhen: o.suggestWhen.filter((c): c is PrSuggestCondition => VALID_PR_CONDITIONS.includes(c as PrSuggestCondition)),
    workspace: o.workspace as PrWorkspaceChoice,
    startPrompt: o.startPrompt,
    updatePrompt: o.updatePrompt
  };
}

function sanitizePrWorkflows(raw: unknown): PrWorkflow[] {
  const list = Array.isArray(raw) ? raw : [];
  const seenIds = new Set<string>();
  const enabledById = new Map<string, boolean>();
  const sanitized: PrWorkflow[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object") {
      const { id, enabled } = entry as Record<string, unknown>;
      if (typeof id === "string" && typeof enabled === "boolean" && !enabledById.has(id.trim())) enabledById.set(id.trim(), enabled);
    }
    const workflow = sanitizeWorkflowEntry(entry);
    if (!workflow || seenIds.has(workflow.id)) continue;
    seenIds.add(workflow.id);
    sanitized.push(workflow);
  }
  for (const builtIn of defaultPrWorkflows()) {
    if (!seenIds.has(builtIn.id)) sanitized.push({ ...builtIn, enabled: enabledById.get(builtIn.id) ?? builtIn.enabled });
  }
  return sanitized;
}

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
  claudeReasoningExpanded: false,
  opencodeReasoningExpanded: false,
  codexReasoningExpanded: false,
  gitBinaryPath: defaultCliBinaryPath("git"),
  githubCliBinaryPath: defaultCliBinaryPath("gh"),
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  holdingHours: 6,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low",
  prRefreshIntervalSeconds: 120,
  prCloneRoot: "~/.cw-code/repos",
  prAttributionEnabled: true,
  prAttributionText: "— drafted with {{harness}} in cw-code",
  prWorkflows: defaultPrWorkflows(),
  opencodeGoUsage: false
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
  if (patch.claudeReasoningExpanded !== undefined) out.claudeReasoningExpanded = patch.claudeReasoningExpanded === true;
  if (patch.opencodeReasoningExpanded !== undefined) out.opencodeReasoningExpanded = patch.opencodeReasoningExpanded === true;
  if (patch.codexReasoningExpanded !== undefined) out.codexReasoningExpanded = patch.codexReasoningExpanded === true;
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
  if (patch.holdingHours !== undefined) {
    const value = Math.round(Number(patch.holdingHours));
    out.holdingHours = Number.isFinite(value) ? Math.min(168, Math.max(0, value)) : 6;
  }
  if (patch.autoTitleEnabled !== undefined) out.autoTitleEnabled = patch.autoTitleEnabled === true;
  if (patch.opencodeGoUsage !== undefined) out.opencodeGoUsage = patch.opencodeGoUsage === true;
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
  if (patch.prRefreshIntervalSeconds !== undefined) {
    const value = Math.round(Number(patch.prRefreshIntervalSeconds));
    out.prRefreshIntervalSeconds = Number.isFinite(value) ? Math.min(3600, Math.max(30, value)) : 120;
  }
  if (patch.prCloneRoot !== undefined) {
    out.prCloneRoot = (typeof patch.prCloneRoot === "string" && patch.prCloneRoot.trim()) || DEFAULT_SETTINGS.prCloneRoot;
  }
  if (patch.prAttributionEnabled !== undefined) out.prAttributionEnabled = patch.prAttributionEnabled === true;
  if (patch.prAttributionText !== undefined) {
    out.prAttributionText =
      typeof patch.prAttributionText === "string" ? patch.prAttributionText.trim() : DEFAULT_SETTINGS.prAttributionText;
  }
  if (patch.prWorkflows !== undefined) out.prWorkflows = sanitizePrWorkflows(patch.prWorkflows);
  return out;
}

function cloneWorkflows(workflows: PrWorkflow[]): PrWorkflow[] {
  return workflows.map((w) => ({ ...w, suggestWhen: [...w.suggestWhen] }));
}

function defaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    claudeEnabledModels: [...DEFAULT_SETTINGS.claudeEnabledModels],
    claudeCustomModel: { ...DEFAULT_SETTINGS.claudeCustomModel },
    prWorkflows: cloneWorkflows(DEFAULT_SETTINGS.prWorkflows)
  };
}

export const SETTINGS_SCHEMA_VERSION = 1;

const KNOWN_SETTING_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

function validateSettingsDocument(raw: unknown): string | null {
  if (!isMetadataDocument(raw)) return "expected a JSON object";
  try {
    sanitize(raw as SettingsPatch);
    return null;
  } catch (error) {
    return `a setting has an unexpected type: ${(error as Error).message}`;
  }
}

export const SETTINGS_METADATA: MetadataSchema = {
  kind: "settings",
  currentVersion: SETTINGS_SCHEMA_VERSION,
  validate: validateSettingsDocument
};

export const SETTINGS_MIGRATIONS: Record<number, MetadataMigration> = { 0: (raw) => raw };

function unknownKeys(document: MetadataDocument): MetadataDocument {
  const extras: MetadataDocument = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "schemaVersion" && !KNOWN_SETTING_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

function serialize(data: AppSettings, extras: MetadataDocument): string {
  return JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, ...data, ...extras });
}

export class SettingsStore {
  private filePath: string;
  private data: AppSettings;
  private extras: MetadataDocument = {};

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const loaded = loadVersionedJson({ filePath: this.filePath, ...SETTINGS_METADATA, migrations: SETTINGS_MIGRATIONS });
    this.data = defaults();
    if (loaded.status === "ok") {
      this.data = { ...this.data, ...sanitize(loaded.data as SettingsPatch) };
      this.extras = unknownKeys(loaded.data);
    }
    const onDisk = loaded.status === "ok" ? JSON.stringify(loaded.data) : null;
    if (serialize(this.data, this.extras) !== onDisk) this.persist();
  }

  get(): AppSettings {
    return { ...this.data, claudeEnabledModels: [...this.data.claudeEnabledModels], prWorkflows: cloneWorkflows(this.data.prWorkflows) };
  }

  set(patch: SettingsPatch): AppSettings {
    this.data = { ...this.data, ...sanitize(patch) };
    this.persist();
    return this.get();
  }

  private persist(): void {
    writeFileAtomic(this.filePath, serialize(this.data, this.extras));
  }
}
