import type { DriverKind, EffortLevel } from "./session.js";
import type { PrWorkflow } from "./pullRequests.js";
import type { SavedGitHubView } from "./github.js";
import type { UpdateChannel } from "./updates.js";

export interface CustomModel {
  id: string;
  name: string;
}

export type PrFinishedSessionStatus = "idle" | "resolved" | "archived" | "none";

export type NotificationSoundId =
  | "tock-up"
  | "wood-steps"
  | "felt-resolve"
  | "felt-chord"
  | "thump-tock"
  | "pop-up"
  | "knock-knock"
  | "ask"
  | "triple-tap"
  | "felt-question"
  | "hollow-knock"
  | "pop-pop"
  | "tock"
  | "soft-tap"
  | "tock-down"
  | "felt-tap"
  | "muted-pluck"
  | "pop";

export type NotificationSoundEvent = "done" | "question" | "prUpdate";

export interface NotificationSoundPreference {
  enabled: boolean;
  sound: NotificationSoundId;
  /** 0 to 100. */
  volume: number;
}

export type NotificationSoundSettings = Record<NotificationSoundEvent, NotificationSoundPreference>;

export type ThemeBase = "dark" | "light";

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeBase;
  colors: Record<string, string>;
}

export interface AppSettings {
  claudeBinaryPath: string;
  opencodeBinaryPath: string;
  codexBinaryPath: string;
  claudeExtraArgs: string;
  opencodeExtraArgs: string;
  codexExtraArgs: string;
  claudeDefaultModel: string;
  codexDefaultModel: string;
  opencodeDefaultModel: string;
  claudeEnabledModels: string[];
  claudeCustomModel: CustomModel;
  claudeReasoningExpanded: boolean;
  /** Launch Claude turns with `--chrome`; seeded once from the CLI's own Chrome default. */
  claudeChromeEnabled: boolean;
  opencodeReasoningExpanded: boolean;
  codexReasoningExpanded: boolean;
  gitBinaryPath: string;
  githubCliBinaryPath: string;
  sourceControlRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
  /** Status applied when a linked pull request is merged or closed. */
  prFinishedSessionStatus: PrFinishedSessionStatus;
  /** Days a session stays idle before it is automatically resolved. 0 disables. */
  idleResolveAfterDays: number;
  /** Automatically return holding sessions to idle after the configured delay. */
  holdingAutoExpireEnabled: boolean;
  /** Hours a session stays in the holding state before returning to idle. */
  holdingHours: number;
  autoTitleEnabled: boolean;
  autoTitleDriver: DriverKind;
  autoTitleModel: string;
  autoTitleEffort: EffortLevel;
  prRefreshIntervalSeconds: number;
  prCloneRoot: string;
  /** Append the repository owner as a folder under the clone root. */
  prCloneIncludeOwner: boolean;
  prAttributionEnabled: boolean;
  prAttributionText: string;
  prWorkflows: PrWorkflow[];
  githubSavedViews: SavedGitHubView[];
  opencodeGoUsage: boolean;
  updateChannel: UpdateChannel | null;
  updateBackgroundDownload: boolean;
  fontFamilySans: string;
  fontFamilyMono: string;
  fontFamilyPrompt: string;
  fontFamilyTerminal: string;
  fontSizeInterface: number;
  fontSizeCode: number;
  fontSizePrompt: number;
  fontSizeTerminal: number;
  typographyAdvanced: boolean;
  panelAnimationMs: number;
  notificationSounds: NotificationSoundSettings;
  themeId: string;
  customThemes: CustomTheme[];
}

export type SettingsPatch = Partial<AppSettings>;
