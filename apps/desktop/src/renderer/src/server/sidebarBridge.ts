import type { SidebarDefaults } from "@cw-code/contracts";
import { SIDEBAR_TOPIC } from "@cw-code/shared/topics";
import { useNotifs } from "../components/Notifications.js";
import { useAppStore } from "../stores/appStore.js";
import { sidebarProjects, sidebarRows } from "./sidebarData.js";
import { bindTopic } from "./topics.js";

const LOAD_NOTIF_ID = "workspace-load";

export function startSidebarBridge(): () => void {
  let lastData: Record<string, unknown> | null = null;
  return bindTopic(SIDEBAR_TOPIC, (state) => {
    if (state.status === "error") {
      useNotifs.getState().upsert({
        id: LOAD_NOTIF_ID,
        kind: "error",
        title: "Could not load sessions",
        message: state.error ?? "The server did not send the session list.",
        sticky: true
      });
    } else if (state.status === "ready") {
      useNotifs.getState().dismiss(LOAD_NOTIF_ID);
    }
    if (state.status !== "ready" || state.data === lastData) return;
    lastData = state.data;
    const defaults = state.data.defaults as SidebarDefaults | undefined;
    useAppStore.getState().applySidebar(sidebarProjects(state.data), sidebarRows(state.data), defaults ?? null);
  });
}
