import type { KeyboardEvent } from "react";
import { useNotifs } from "./Notifications.js";

export function openExternalLink(url: string): void {
  void window.cw.openExternal(url).catch(() => {
    useNotifs.getState().push({ kind: "error", title: "Could not open link", message: url });
  });
}

export function buttonProps(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onActivate();
    }
  };
}
