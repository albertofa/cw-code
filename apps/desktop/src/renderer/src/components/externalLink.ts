import { useNotifs } from "./Notifications.js";

export function openExternalLink(url: string): void {
  void window.cw.openExternal(url).catch(() => {
    useNotifs.getState().push({ kind: "error", title: "Could not open link", message: url });
  });
}
