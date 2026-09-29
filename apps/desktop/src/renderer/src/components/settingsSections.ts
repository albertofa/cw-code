import type { AppSettings, DriverName } from "../cw.js";

export type SettingsSection = "general" | "appearance" | "updates" | "sourceControl" | "prWorkflows" | "harness";

export type SettingsNavId = Exclude<SettingsSection, "harness"> | DriverName;

export interface SettingsNavItem {
  id: SettingsNavId;
  label: string;
  group: "app" | "harnesses";
}

export const HARNESS_NAMES: Record<DriverName, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  codex: "Codex"
};

export const HARNESS_IDS: DriverName[] = ["claude", "opencode", "codex"];

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: "general", label: "General", group: "app" },
  { id: "appearance", label: "Appearance", group: "app" },
  { id: "updates", label: "Updates", group: "app" },
  { id: "sourceControl", label: "Source control", group: "app" },
  { id: "prWorkflows", label: "PR workflows", group: "app" },
  ...HARNESS_IDS.map((id): SettingsNavItem => ({ id, label: HARNESS_NAMES[id], group: "harnesses" }))
];

const SETTING_OWNER: Record<keyof AppSettings, SettingsNavId> = {
  claudeBinaryPath: "claude",
  opencodeBinaryPath: "opencode",
  codexBinaryPath: "codex",
  claudeExtraArgs: "claude",
  opencodeExtraArgs: "opencode",
  codexExtraArgs: "codex",
  claudeDefaultModel: "claude",
  codexDefaultModel: "codex",
  opencodeDefaultModel: "opencode",
  claudeEnabledModels: "claude",
  claudeCustomModel: "claude",
  claudeReasoningExpanded: "claude",
  opencodeReasoningExpanded: "opencode",
  codexReasoningExpanded: "codex",
  gitBinaryPath: "sourceControl",
  githubCliBinaryPath: "sourceControl",
  sourceControlRefreshIntervalSeconds: "sourceControl",
  defaultUseWorktree: "sourceControl",
  holdingAutoExpireEnabled: "general",
  holdingHours: "general",
  autoTitleEnabled: "general",
  autoTitleDriver: "general",
  autoTitleModel: "general",
  autoTitleEffort: "general",
  prRefreshIntervalSeconds: "prWorkflows",
  prCloneRoot: "prWorkflows",
  prAttributionEnabled: "prWorkflows",
  prAttributionText: "prWorkflows",
  prWorkflows: "prWorkflows",
  opencodeGoUsage: "opencode",
  updateChannel: "updates",
  updateBackgroundDownload: "updates",
  fontFamilySans: "appearance",
  fontFamilyMono: "appearance",
  fontFamilyPrompt: "appearance",
  fontFamilyTerminal: "appearance",
  fontSizeInterface: "appearance",
  fontSizeCode: "appearance",
  fontSizePrompt: "appearance",
  fontSizeTerminal: "appearance",
  typographyAdvanced: "appearance",
  panelAnimationMs: "appearance"
};

export function navIdOf(section: SettingsSection, harness: DriverName | undefined): SettingsNavId {
  return section === "harness" ? (harness ?? "claude") : section;
}

function isHarnessId(id: SettingsNavId): id is DriverName {
  return HARNESS_IDS.some((driver) => driver === id);
}

export function viewOfNavId(id: SettingsNavId): { section: SettingsSection; harness?: DriverName } {
  return isHarnessId(id) ? { section: "harness", harness: id } : { section: id };
}

export function navLabel(id: SettingsNavId): string {
  return SETTINGS_NAV.find((item) => item.id === id)?.label ?? id;
}

export function filterSettingsNav(items: SettingsNavItem[], query: string): SettingsNavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && sameValue(value, right.get(key)));
}

export function changedSections(saved: AppSettings, draft: AppSettings): SettingsNavId[] {
  const owners = new Set<SettingsNavId>();
  for (const key of Object.keys(SETTING_OWNER) as Array<keyof AppSettings>) {
    if (!sameValue(saved[key], draft[key])) owners.add(SETTING_OWNER[key]);
  }
  return SETTINGS_NAV.map((item) => item.id).filter((id) => owners.has(id));
}
