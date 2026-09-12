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
}

export type SettingsPatch = Partial<AppSettings>;
