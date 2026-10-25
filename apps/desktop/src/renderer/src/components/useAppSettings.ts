import type { AppTopicData } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import type { AppSettings } from "../cw.js";
import { useTopic } from "../server/topics.js";

export function useAppSettings(): AppSettings | null {
  return useTopic<Partial<AppTopicData>>(APP_TOPIC)?.data.settings ?? null;
}

export function useAppSettingsError(): string | null {
  const state = useTopic<Partial<AppTopicData>>(APP_TOPIC);
  return state?.status === "error" && !state.data.settings ? (state.error ?? "Settings are unavailable") : null;
}
