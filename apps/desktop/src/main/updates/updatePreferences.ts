import type { AppSettings, UpdateChannel } from "@cw-code/contracts";
import { channelOfVersion } from "./updateState.js";

export interface UpdatePreferences {
  channel: UpdateChannel;
  autoDownload: boolean;
}

export function updatePreferences(
  settings: Pick<AppSettings, "updateChannel" | "updateBackgroundDownload">,
  runningVersion: string
): UpdatePreferences {
  return {
    channel: settings.updateChannel ?? channelOfVersion(runningVersion),
    autoDownload: settings.updateBackgroundDownload
  };
}

export function touchesUpdatePreferences(patch: Partial<AppSettings>): boolean {
  return patch.updateChannel !== undefined || patch.updateBackgroundDownload !== undefined;
}
