import type { AppTopicData } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import type { AppSettings } from "../cw.js";
import { useTopicEntry, useTopicSelect } from "../server/topics.js";

export function useAppSettings(): AppSettings | null {
  return useTopicEntry<AppSettings>(APP_TOPIC, "settings") ?? null;
}

export function useAppSettingsError(): string | null {
  return useTopicSelect<string | null, Partial<AppTopicData>>(APP_TOPIC, (state) =>
    state?.status === "error" && !state.data.settings ? (state.error ?? "Settings are unavailable") : null
  );
}
