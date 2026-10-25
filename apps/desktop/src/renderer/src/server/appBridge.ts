import type { AppTopicData, DriverKind } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import type { AppSettings } from "../cw.js";
import { fallbackHarness } from "../components/harnessAvailability.js";
import { useAppStore } from "../stores/appStore.js";
import { useGitHubStore } from "../stores/githubStore.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { bindTopic } from "./topics.js";

export function applyInstalledHarnesses(installed: DriverKind[]): void {
  const app = useAppStore.getState();
  const pending = app.pendingDriver;
  useAppStore.setState({ installedHarnesses: installed, lastDriver: fallbackHarness(app.lastDriver, installed) });
  if (pending !== null) useAppStore.getState().setPendingDriver(fallbackHarness(pending, installed));
}

function applySettings(settings: AppSettings): void {
  useAppStore.getState().applySettings(settings);
  useGitHubStore.getState().applySavedViews(settings.githubSavedViews ?? []);
  useSettingsDraftStore.getState().applyStored(settings);
}

export function startAppBridge(): () => void {
  let settingsKey: string | null = null;
  let homeDir: string | undefined;
  let installedKey: string | null = null;
  return bindTopic<Partial<AppTopicData>>(APP_TOPIC, (state) => {
    const data = state.data;
    const settingsJson = data.settings ? JSON.stringify(data.settings) : null;
    if (data.settings && settingsJson !== settingsKey) {
      settingsKey = settingsJson;
      applySettings(data.settings);
    }
    if (data.home && data.home.homeDir !== homeDir) {
      homeDir = data.home.homeDir;
      useAppStore.setState({ homeDir });
    }
    const harnesses = data.harnesses;
    if (harnesses && harnesses.checkedAt !== null && JSON.stringify(harnesses.installed) !== installedKey) {
      installedKey = JSON.stringify(harnesses.installed);
      applyInstalledHarnesses(harnesses.installed);
    }
  });
}
