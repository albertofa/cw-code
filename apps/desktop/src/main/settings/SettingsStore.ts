import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings, PrSuggestCondition, PrWorkflow, PrWorkflowIcon, PrWorkspaceChoice, SettingsPatch } from "@cw-code/contracts";
import { CLAUDE_CURATED_MODELS } from "../providers/claude/ClaudeCliDriver.js";
import { readBytesIfExists, writeFileAtomic } from "../storage/atomicFile.js";
import { beforeRepairBackupPath, writeVerified } from "../storage/backups.js";
import {
  describeError,
  isMetadataDocument,
  MetadataError,
  type MetadataDocument,
  type MetadataMigration,
  type MetadataSchema
} from "../storage/metadataDocument.js";
import { loadVersionedJson } from "../storage/versionedJson.js";
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
  holdingAutoExpireEnabled: false,
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
  opencodeGoUsage: false,
  updateChannel: null,
  updateBackgroundDownload: true
};

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function binaryPathOr(value: unknown, fallback: string): string {
  return (typeof value === "string" && normalizeBinaryPath(value)) || fallback;
}

function sanitize(patch: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (patch.claudeBinaryPath !== undefined) {
    out.claudeBinaryPath =
      typeof patch.claudeBinaryPath === "string"
        ? configuredCliBinaryPath("claude", patch.claudeBinaryPath)
        : DEFAULT_SETTINGS.claudeBinaryPath;
  }
  if (patch.opencodeBinaryPath !== undefined) out.opencodeBinaryPath = binaryPathOr(patch.opencodeBinaryPath, DEFAULT_SETTINGS.opencodeBinaryPath);
  if (patch.codexBinaryPath !== undefined) out.codexBinaryPath = binaryPathOr(patch.codexBinaryPath, DEFAULT_SETTINGS.codexBinaryPath);
  if (patch.claudeExtraArgs !== undefined) out.claudeExtraArgs = trimmedOr(patch.claudeExtraArgs, DEFAULT_SETTINGS.claudeExtraArgs);
  if (patch.opencodeExtraArgs !== undefined) out.opencodeExtraArgs = trimmedOr(patch.opencodeExtraArgs, DEFAULT_SETTINGS.opencodeExtraArgs);
  if (patch.codexExtraArgs !== undefined) out.codexExtraArgs = trimmedOr(patch.codexExtraArgs, DEFAULT_SETTINGS.codexExtraArgs);
  if (patch.claudeDefaultModel !== undefined) out.claudeDefaultModel = trimmedOr(patch.claudeDefaultModel, DEFAULT_SETTINGS.claudeDefaultModel);
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
    } else {
      out.claudeCustomModel = { ...DEFAULT_SETTINGS.claudeCustomModel };
    }
  }
  if (patch.claudeEnabledModels !== undefined) {
    const raw: unknown = patch.claudeEnabledModels;
    out.claudeEnabledModels = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : [...DEFAULT_SETTINGS.claudeEnabledModels];
  }
  if (patch.claudeReasoningExpanded !== undefined) out.claudeReasoningExpanded = patch.claudeReasoningExpanded === true;
  if (patch.opencodeReasoningExpanded !== undefined) out.opencodeReasoningExpanded = patch.opencodeReasoningExpanded === true;
  if (patch.codexReasoningExpanded !== undefined) out.codexReasoningExpanded = patch.codexReasoningExpanded === true;
  if (patch.gitBinaryPath !== undefined) out.gitBinaryPath = binaryPathOr(patch.gitBinaryPath, DEFAULT_SETTINGS.gitBinaryPath);
  if (patch.githubCliBinaryPath !== undefined) out.githubCliBinaryPath = binaryPathOr(patch.githubCliBinaryPath, DEFAULT_SETTINGS.githubCliBinaryPath);
  if (patch.sourceControlRefreshIntervalSeconds !== undefined) {
    const value = Math.round(Number(patch.sourceControlRefreshIntervalSeconds));
    out.sourceControlRefreshIntervalSeconds = Number.isFinite(value) ? Math.min(3600, Math.max(5, value)) : 30;
  }
  if (patch.defaultUseWorktree !== undefined) out.defaultUseWorktree = patch.defaultUseWorktree === true;
  if (patch.holdingAutoExpireEnabled !== undefined) out.holdingAutoExpireEnabled = patch.holdingAutoExpireEnabled === true;
  if (patch.holdingHours !== undefined) {
    const value = Math.round(Number(patch.holdingHours));
    out.holdingHours = Number.isFinite(value) ? (value === 0 ? 6 : Math.min(168, Math.max(1, value))) : 6;
  }
  if (patch.autoTitleEnabled !== undefined) out.autoTitleEnabled = patch.autoTitleEnabled === true;
  if (patch.opencodeGoUsage !== undefined) out.opencodeGoUsage = patch.opencodeGoUsage === true;
  if (patch.autoTitleDriver !== undefined) {
    out.autoTitleDriver =
      patch.autoTitleDriver === "claude" || patch.autoTitleDriver === "opencode" || patch.autoTitleDriver === "codex"
        ? patch.autoTitleDriver
        : DEFAULT_SETTINGS.autoTitleDriver;
  }
  if (patch.autoTitleModel !== undefined) out.autoTitleModel = trimmedOr(patch.autoTitleModel, DEFAULT_SETTINGS.autoTitleModel);
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
  if (patch.updateChannel !== undefined) {
    out.updateChannel = patch.updateChannel === "stable" || patch.updateChannel === "alpha" ? patch.updateChannel : DEFAULT_SETTINGS.updateChannel;
  }
  if (patch.updateBackgroundDownload !== undefined) {
    out.updateBackgroundDownload =
      typeof patch.updateBackgroundDownload === "boolean" ? patch.updateBackgroundDownload : DEFAULT_SETTINGS.updateBackgroundDownload;
  }
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
  return isMetadataDocument(raw) ? null : "expected a JSON object";
}

export const SETTINGS_METADATA: MetadataSchema = {
  kind: "settings",
  currentVersion: SETTINGS_SCHEMA_VERSION,
  validate: validateSettingsDocument,
  empty: () => ({ schemaVersion: SETTINGS_SCHEMA_VERSION })
};

export const SETTINGS_MIGRATIONS: Record<number, MetadataMigration> = { 0: (raw) => raw };

function unknownKeys(document: MetadataDocument): MetadataDocument {
  const extras: MetadataDocument = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "schemaVersion" && !KNOWN_SETTING_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

function repairedKeys(document: MetadataDocument, data: AppSettings): string[] {
  return Object.keys(document).filter(
    (key) => KNOWN_SETTING_KEYS.has(key) && JSON.stringify(document[key]) !== JSON.stringify(data[key as keyof AppSettings])
  );
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
    if (loaded.status !== "ok") {
      this.persist();
      return;
    }
    this.data = { ...this.data, ...sanitize(loaded.data as SettingsPatch) };
    this.extras = unknownKeys(loaded.data);
    if (serialize(this.data, this.extras) === JSON.stringify(loaded.data)) return;
    const repaired = repairedKeys(loaded.data, this.data);
    if (repaired.length > 0) this.backupBeforeRepair(repaired);
    this.persist();
  }

  get(): AppSettings {
    return { ...this.data, claudeEnabledModels: [...this.data.claudeEnabledModels], prWorkflows: cloneWorkflows(this.data.prWorkflows) };
  }

  set(patch: SettingsPatch): AppSettings {
    const next = { ...this.data, ...sanitize(patch) };
    writeFileAtomic(this.filePath, serialize(next, this.extras));
    this.data = next;
    return this.get();
  }

  private backupBeforeRepair(keys: string[]): void {
    const backupPath = beforeRepairBackupPath(this.filePath);
    try {
      const original = readBytesIfExists(this.filePath);
      if (original && !readBytesIfExists(backupPath)?.equals(original)) writeVerified(backupPath, original);
    } catch (error) {
      throw new MetadataError({
        kind: "io",
        file: this.filePath,
        store: "settings",
        supportedVersion: SETTINGS_SCHEMA_VERSION,
        detail: `could not back up settings before repairing ${keys.join(", ")}: ${describeError(error)}`
      });
    }
    console.warn(`repaired settings ${keys.join(", ")} in ${this.filePath}; the previous file is kept at ${backupPath}`);
  }

  private persist(): void {
    writeFileAtomic(this.filePath, serialize(this.data, this.extras));
  }
}
