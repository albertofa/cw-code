import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AppSettings,
  DriverKind,
  EffortLevel,
  GitHubKind,
  GitHubViewGroup,
  GroqVoiceModel,
  NotificationSoundId,
  NotificationSoundPreference,
  NotificationSoundSettings,
  PermissionMode,
  PrFinishedSessionStatus,
  PrSuggestCondition,
  PrWorkflow,
  PrWorkflowHarness,
  PrWorkflowIcon,
  PrWorkspaceChoice,
  SavedGitHubView,
  SettingsPatch,
  VoiceLanguage,
  VoiceProvider
} from "@cw-code/contracts";
import { CLAUDE_CURATED_MODELS } from "../providers/claude/ClaudeCliDriver.js";
import { writeFileAtomic } from "../storage/atomicFile.js";
import { backupBeforeRepair } from "../storage/backups.js";
import { isMetadataDocument, type MetadataDocument, type MetadataMigration, type MetadataSchema } from "../storage/metadataDocument.js";
import { LastGoodRefresher, loadVersionedJson } from "../storage/versionedJson.js";
import { defaultPrWorkflows, RETIRED_BUILT_IN_PROMPTS } from "./prWorkflowDefaults.js";
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
  "draft",
  "issue-assigned",
  "issue-bug",
  "run-failed"
];
const VALID_WORKFLOW_TARGETS: readonly PrWorkflow["target"][] = ["pr", "issue", "run"];
const VALID_PR_WORKSPACES: readonly PrWorkspaceChoice[] = ["checkout", "worktree", "linked"];
const VALID_DRIVERS: readonly DriverKind[] = ["claude", "opencode", "codex"];
const VALID_EFFORTS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const VALID_PERMISSION_MODES: readonly PermissionMode[] = ["auto", "acceptEdits", "bypassPermissions", "manual"];
const VALID_VIEW_KINDS: readonly GitHubKind[] = ["pr", "issue", "run"];
const VALID_VIEW_GROUPS: readonly GitHubViewGroup[] = ["triage", "repo", "none"];
const MAX_SAVED_VIEWS = 50;
const MAX_VIEW_NAME_LENGTH = 80;
const MAX_VIEW_QUERY_LENGTH = 512;
const VALID_PR_FINISHED_STATUSES: readonly PrFinishedSessionStatus[] = ["idle", "resolved", "archived", "none"];
const VALID_NOTIFICATION_SOUNDS: readonly NotificationSoundId[] = [
  "tock-up",
  "wood-steps",
  "felt-resolve",
  "felt-chord",
  "thump-tock",
  "pop-up",
  "knock-knock",
  "ask",
  "triple-tap",
  "felt-question",
  "hollow-knock",
  "pop-pop",
  "tock",
  "soft-tap",
  "tock-down",
  "felt-tap",
  "muted-pluck",
  "pop"
];

const VALID_VOICE_PROVIDERS: readonly VoiceProvider[] = ["off", "groq"];
const VALID_VOICE_LANGUAGES: readonly VoiceLanguage[] = ["pt", "en", "es", "auto"];
const VALID_GROQ_VOICE_MODELS: readonly GroqVoiceModel[] = ["whisper-large-v3-turbo", "whisper-large-v3"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

function sanitizeWorkflowHarness(raw: unknown): PrWorkflowHarness {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const driver = oneOf(o.driver, VALID_DRIVERS);
  return {
    driver,
    model: driver && typeof o.model === "string" ? o.model.trim() : "",
    effort: oneOf(o.effort, VALID_EFFORTS),
    permissionMode: oneOf(o.permissionMode, VALID_PERMISSION_MODES)
  };
}

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
    target: VALID_WORKFLOW_TARGETS.includes(o.target as PrWorkflow["target"]) ? (o.target as PrWorkflow["target"]) : "pr",
    suggestWhen: o.suggestWhen.filter((c): c is PrSuggestCondition => VALID_PR_CONDITIONS.includes(c as PrSuggestCondition)),
    workspace: o.workspace as PrWorkspaceChoice,
    harness: sanitizeWorkflowHarness(o.harness),
    startPrompt: o.startPrompt,
    updatePrompt: o.updatePrompt,
    ...(typeof o.autoFollowUp === "boolean" ? { autoFollowUp: o.autoFollowUp } : {})
  };
}

function upgradeBuiltIn(workflow: PrWorkflow, builtIn: PrWorkflow | undefined): PrWorkflow {
  if (!workflow.builtIn || !builtIn) return workflow;
  const next = { ...workflow };
  if (next.autoFollowUp === undefined && builtIn.autoFollowUp !== undefined) next.autoFollowUp = builtIn.autoFollowUp;
  for (const retired of RETIRED_BUILT_IN_PROMPTS) {
    if (retired.id === workflow.id && next[retired.field] === retired.text) next[retired.field] = builtIn[retired.field];
  }
  return next;
}

function sanitizePrWorkflows(raw: unknown): PrWorkflow[] {
  const list = Array.isArray(raw) ? raw : [];
  const defaults = defaultPrWorkflows();
  const defaultsById = new Map(defaults.map((workflow) => [workflow.id, workflow]));
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
    sanitized.push(upgradeBuiltIn(workflow, defaultsById.get(workflow.id)));
  }
  for (const builtIn of defaults) {
    if (!seenIds.has(builtIn.id)) sanitized.push({ ...builtIn, enabled: enabledById.get(builtIn.id) ?? builtIn.enabled });
  }
  return sanitized;
}

function sanitizeSavedView(entry: unknown): SavedGitHubView | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  if (!VALID_VIEW_KINDS.includes(o.kind as GitHubKind)) return null;
  if (!VALID_VIEW_GROUPS.includes(o.group as GitHubViewGroup)) return null;
  if (typeof o.name !== "string" || typeof o.query !== "string") return null;
  const name = o.name.trim();
  const query = o.query.trim();
  if (!name || !query || name.length > MAX_VIEW_NAME_LENGTH || query.length > MAX_VIEW_QUERY_LENGTH) return null;
  return { id, kind: o.kind as GitHubKind, name, query, group: o.group as GitHubViewGroup };
}

function sanitizeSavedViews(raw: unknown): SavedGitHubView[] {
  const list = Array.isArray(raw) ? raw : [];
  const seenIds = new Set<string>();
  const views: SavedGitHubView[] = [];
  for (const entry of list) {
    const view = sanitizeSavedView(entry);
    if (!view || seenIds.has(view.id)) continue;
    seenIds.add(view.id);
    views.push(view);
    if (views.length === MAX_SAVED_VIEWS) break;
  }
  return views;
}

export const DEFAULT_SETTINGS: AppSettings = {
  claudeBinaryPath: defaultCliBinaryPath("claude"),
  opencodeBinaryPath: defaultCliBinaryPath("opencode"),
  codexBinaryPath: defaultCliBinaryPath("codex"),
  claudeExtraArgs: "",
  opencodeExtraArgs: "",
  codexExtraArgs: "",
  claudeDefaultModel: "",
  codexDefaultModel: "",
  opencodeDefaultModel: "",
  claudeEnabledModels: CLAUDE_CURATED_MODELS.map((m) => m.id),
  claudeCustomModel: { id: "", name: "" },
  claudeReasoningExpanded: false,
  opencodeReasoningExpanded: false,
  codexReasoningExpanded: false,
  gitBinaryPath: defaultCliBinaryPath("git"),
  githubCliBinaryPath: defaultCliBinaryPath("gh"),
  sourceControlRefreshIntervalSeconds: 30,
  defaultUseWorktree: true,
  prFinishedSessionStatus: "idle",
  idleResolveAfterDays: 30,
  holdingAutoExpireEnabled: false,
  holdingHours: 6,
  autoTitleEnabled: true,
  autoTitleDriver: "claude",
  autoTitleModel: "claude-sonnet-5",
  autoTitleEffort: "low",
  prRefreshIntervalSeconds: 120,
  prCloneRoot: "~/.cw-code/repos",
  prCloneIncludeOwner: true,
  prAttributionEnabled: true,
  prAttributionText: "— drafted with {{harness}} in cw-code",
  prWorkflows: defaultPrWorkflows(),
  githubSavedViews: [],
  opencodeGoUsage: false,
  updateChannel: null,
  updateBackgroundDownload: true,
  fontFamilySans: "",
  fontFamilyMono: "",
  fontFamilyPrompt: "",
  fontFamilyTerminal: "",
  fontSizeInterface: 16,
  fontSizeCode: 14,
  fontSizePrompt: 14,
  fontSizeTerminal: 14,
  typographyAdvanced: false,
  panelAnimationMs: 0,
  notificationSounds: {
    done: { enabled: true, sound: "felt-chord", volume: 60 },
    question: { enabled: true, sound: "triple-tap", volume: 60 },
    prUpdate: { enabled: true, sound: "tock-down", volume: 60 }
  },
  voiceProvider: "off",
  voiceLanguage: "pt",
  voiceGroqModel: "whisper-large-v3-turbo"
};

const FONT_FAMILY_MAX_LENGTH = 200;

function fontFamilyOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim().slice(0, FONT_FAMILY_MAX_LENGTH).trim() : fallback;
}

function clampedIntegerOr(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined) return fallback;
  const rounded = Math.round(Number(value));
  return Number.isFinite(rounded) ? Math.min(max, Math.max(min, rounded)) : fallback;
}

function steppedIntegerOr(value: unknown, fallback: number, min: number, max: number, step: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
}

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function binaryPathOr(value: unknown, fallback: string): string {
  return (typeof value === "string" && normalizeBinaryPath(value)) || fallback;
}

function sanitizeSoundPreference(raw: unknown, fallback: NotificationSoundPreference): NotificationSoundPreference {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : fallback.enabled,
    sound: oneOf(o.sound, VALID_NOTIFICATION_SOUNDS) ?? fallback.sound,
    volume: clampedIntegerOr(o.volume, fallback.volume, 0, 100)
  };
}

function sanitizeNotificationSounds(raw: unknown): NotificationSoundSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_SETTINGS.notificationSounds;
  return {
    done: sanitizeSoundPreference(o.done, defaults.done),
    question: sanitizeSoundPreference(o.question, defaults.question),
    prUpdate: sanitizeSoundPreference(o.prUpdate, defaults.prUpdate)
  };
}

function cloneNotificationSounds(sounds: NotificationSoundSettings): NotificationSoundSettings {
  return { done: { ...sounds.done }, question: { ...sounds.question }, prUpdate: { ...sounds.prUpdate } };
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
  if (patch.codexDefaultModel !== undefined) out.codexDefaultModel = trimmedOr(patch.codexDefaultModel, DEFAULT_SETTINGS.codexDefaultModel);
  if (patch.opencodeDefaultModel !== undefined) out.opencodeDefaultModel = trimmedOr(patch.opencodeDefaultModel, DEFAULT_SETTINGS.opencodeDefaultModel);
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
  if (patch.prFinishedSessionStatus !== undefined) {
    out.prFinishedSessionStatus = VALID_PR_FINISHED_STATUSES.includes(patch.prFinishedSessionStatus)
      ? patch.prFinishedSessionStatus
      : DEFAULT_SETTINGS.prFinishedSessionStatus;
  }
  if (patch.idleResolveAfterDays !== undefined) {
    const value = Math.round(Number(patch.idleResolveAfterDays));
    out.idleResolveAfterDays = Number.isFinite(value) ? Math.min(365, Math.max(0, value)) : 30;
  }
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
  if (patch.prCloneIncludeOwner !== undefined) out.prCloneIncludeOwner = patch.prCloneIncludeOwner === true;
  if (patch.prAttributionEnabled !== undefined) out.prAttributionEnabled = patch.prAttributionEnabled === true;
  if (patch.prAttributionText !== undefined) {
    out.prAttributionText =
      typeof patch.prAttributionText === "string" ? patch.prAttributionText.trim() : DEFAULT_SETTINGS.prAttributionText;
  }
  if (patch.prWorkflows !== undefined) out.prWorkflows = sanitizePrWorkflows(patch.prWorkflows);
  if (patch.githubSavedViews !== undefined) out.githubSavedViews = sanitizeSavedViews(patch.githubSavedViews);
  if (patch.updateChannel !== undefined) {
    out.updateChannel = patch.updateChannel === "stable" || patch.updateChannel === "alpha" ? patch.updateChannel : DEFAULT_SETTINGS.updateChannel;
  }
  if (patch.updateBackgroundDownload !== undefined) {
    out.updateBackgroundDownload =
      typeof patch.updateBackgroundDownload === "boolean" ? patch.updateBackgroundDownload : DEFAULT_SETTINGS.updateBackgroundDownload;
  }
  if (patch.fontFamilySans !== undefined) out.fontFamilySans = fontFamilyOr(patch.fontFamilySans, DEFAULT_SETTINGS.fontFamilySans);
  if (patch.fontFamilyMono !== undefined) out.fontFamilyMono = fontFamilyOr(patch.fontFamilyMono, DEFAULT_SETTINGS.fontFamilyMono);
  if (patch.fontFamilyPrompt !== undefined) out.fontFamilyPrompt = fontFamilyOr(patch.fontFamilyPrompt, DEFAULT_SETTINGS.fontFamilyPrompt);
  if (patch.fontFamilyTerminal !== undefined) out.fontFamilyTerminal = fontFamilyOr(patch.fontFamilyTerminal, DEFAULT_SETTINGS.fontFamilyTerminal);
  if (patch.fontSizeInterface !== undefined) out.fontSizeInterface = clampedIntegerOr(patch.fontSizeInterface, DEFAULT_SETTINGS.fontSizeInterface, 12, 20);
  if (patch.fontSizeCode !== undefined) out.fontSizeCode = clampedIntegerOr(patch.fontSizeCode, DEFAULT_SETTINGS.fontSizeCode, 10, 18);
  if (patch.fontSizePrompt !== undefined) out.fontSizePrompt = clampedIntegerOr(patch.fontSizePrompt, DEFAULT_SETTINGS.fontSizePrompt, 12, 20);
  if (patch.fontSizeTerminal !== undefined) out.fontSizeTerminal = clampedIntegerOr(patch.fontSizeTerminal, DEFAULT_SETTINGS.fontSizeTerminal, 8, 20);
  if (patch.typographyAdvanced !== undefined) out.typographyAdvanced = patch.typographyAdvanced === true;
  if (patch.panelAnimationMs !== undefined) out.panelAnimationMs = steppedIntegerOr(patch.panelAnimationMs, DEFAULT_SETTINGS.panelAnimationMs, 0, 400, 25);
  if (patch.notificationSounds !== undefined) out.notificationSounds = sanitizeNotificationSounds(patch.notificationSounds);
  if (patch.voiceProvider !== undefined) out.voiceProvider = oneOf(patch.voiceProvider, VALID_VOICE_PROVIDERS) ?? DEFAULT_SETTINGS.voiceProvider;
  if (patch.voiceLanguage !== undefined) out.voiceLanguage = oneOf(patch.voiceLanguage, VALID_VOICE_LANGUAGES) ?? DEFAULT_SETTINGS.voiceLanguage;
  if (patch.voiceGroqModel !== undefined) out.voiceGroqModel = oneOf(patch.voiceGroqModel, VALID_GROQ_VOICE_MODELS) ?? DEFAULT_SETTINGS.voiceGroqModel;
  return out;
}

function cloneWorkflows(workflows: PrWorkflow[]): PrWorkflow[] {
  return workflows.map((w) => ({ ...w, suggestWhen: [...w.suggestWhen], harness: { ...w.harness } }));
}

function defaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    claudeEnabledModels: [...DEFAULT_SETTINGS.claudeEnabledModels],
    claudeCustomModel: { ...DEFAULT_SETTINGS.claudeCustomModel },
    prWorkflows: cloneWorkflows(DEFAULT_SETTINGS.prWorkflows),
    githubSavedViews: [...DEFAULT_SETTINGS.githubSavedViews],
    notificationSounds: cloneNotificationSounds(DEFAULT_SETTINGS.notificationSounds)
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
  return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "schemaVersion" && !KNOWN_SETTING_KEYS.has(key)));
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
  private lastGood: LastGoodRefresher;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const loaded = loadVersionedJson({ filePath: this.filePath, ...SETTINGS_METADATA, migrations: SETTINGS_MIGRATIONS });
    this.lastGood = new LastGoodRefresher(this.filePath);
    this.data = defaults();
    if (loaded.status !== "ok") {
      this.persist();
      return;
    }
    this.data = { ...this.data, ...sanitize(loaded.data as SettingsPatch) };
    this.extras = unknownKeys(loaded.data);
    if (serialize(this.data, this.extras) === JSON.stringify(loaded.data)) return;
    const repaired = repairedKeys(loaded.data, this.data);
    if (repaired.length > 0) backupBeforeRepair(this.filePath, SETTINGS_METADATA, repaired);
    this.persist();
  }

  get(): AppSettings {
    return {
      ...this.data,
      claudeEnabledModels: [...this.data.claudeEnabledModels],
      prWorkflows: cloneWorkflows(this.data.prWorkflows),
      githubSavedViews: this.data.githubSavedViews.map((view) => ({ ...view })),
      notificationSounds: cloneNotificationSounds(this.data.notificationSounds)
    };
  }

  set(patch: SettingsPatch): AppSettings {
    const next = { ...this.data, ...sanitize(patch) };
    writeFileAtomic(this.filePath, serialize(next, this.extras));
    this.data = next;
    this.lastGood.afterPersist();
    return this.get();
  }

  flush(): void {
    this.lastGood.flush();
  }

  private persist(): void {
    writeFileAtomic(this.filePath, serialize(this.data, this.extras));
    this.lastGood.afterPersist();
  }
}
