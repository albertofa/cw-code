import { useEffect } from "react";
import type { AppTopicData } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { useTopicSelect } from "../server/topics.js";

const BASE_TITLE = "cw-code";

export function attentionTitle(count: number): string {
  return count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

export function useBrowserAttentionTitle(enabled: boolean): void {
  const count = useTopicSelect<number, Partial<AppTopicData>>(enabled ? APP_TOPIC : null, (state) => state?.data.attention?.count ?? 0);
  useEffect(() => {
    if (enabled) document.title = attentionTitle(count);
  }, [enabled, count]);
}
