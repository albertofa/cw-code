import type { DriverKind, EffortLevel } from "./session.js";

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
  gitBinaryPath: string;
  githubCliBinaryPath: string;
  sourceControlRefreshIntervalSeconds: number;
  defaultUseWorktree: boolean;
  /** Hours a session stays in the holding state before it is resolved automatically. */
  holdingHours: number;
  autoTitleEnabled: boolean;
  autoTitleDriver: DriverKind;
  autoTitleModel: string;
  autoTitleEffort: EffortLevel;
}

export type SettingsPatch = Partial<AppSettings>;
