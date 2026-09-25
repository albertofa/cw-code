import type { DriverKind, EffortLevel } from "./session.js";
import type { PrWorkflow } from "./pullRequests.js";

export interface CustomModel {
  id: string;
  name: string;
}

export interface AppSettings {
  claudeBinaryPath: string;
  opencodeBinaryPath: string;
  codexBinaryPath: string;
  claudeExtraArgs: string;
  opencodeExtraArgs: string;
  codexExtraArgs: string;
  claudeDefaultModel: string;
  claudeEnabledModels: string[];
  claudeCustomModel: CustomModel;
  claudeReasoningExpanded: boolean;
  opencodeReasoningExpanded: boolean;
  codexReasoningExpanded: boolean;
  gitBinaryPath: string;
  githubCliBinaryPath: string;
  sourceControlRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
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
  prAttributionEnabled: boolean;
  prAttributionText: string;
  prWorkflows: PrWorkflow[];
  opencodeGoUsage: boolean;
}

export type SettingsPatch = Partial<AppSettings>;
