import type { AppTopicData } from "@cw-code/contracts";
import type { TopicState } from "@cw-code/client";
import { APP_TOPIC } from "@cw-code/shared/topics";
import type { DriverName } from "../cw.js";
import { peekTopic, useTopicSelect } from "../server/topics.js";

type AppState = TopicState<Partial<AppTopicData>> | undefined;

const NO_MODELS: string[] = [];

function recentsOf(state: AppState, driver: DriverName): string[] {
  return state?.data.recentModels?.[driver] ?? NO_MODELS;
}

export function getRecentModels(driver: DriverName): string[] {
  return recentsOf(peekTopic<Partial<AppTopicData>>(APP_TOPIC), driver);
}

export function useRecentModels(driver: DriverName): string[] {
  return useTopicSelect<string[], Partial<AppTopicData>>(APP_TOPIC, (state) => recentsOf(state, driver));
}

export function getLastModel(driver: DriverName): string | null {
  return getRecentModels(driver)[0] ?? null;
}

export function pushRecentModel(driver: DriverName, model: string): void {
  if (!model) return;
  window.cw.pushRecentModel(driver, model).catch((err: unknown) => console.warn("[cw-code] could not save the recent model", err));
}
