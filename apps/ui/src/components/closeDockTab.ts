import type { DockableTabId } from "@cw-code/contracts";
import { usePanelStore } from "../stores/panelStore.js";
import { useNotifs } from "./Notifications.js";
import { confirmGlobally } from "./GlobalConfirm.js";
import { isPtyLive } from "./ptyLiveness.js";
import { harnessLabel } from "./toolTabs.js";

type PtyTabKind = "claude" | "opencode" | "codex" | "shell";
const PTY_TABS: ReadonlySet<DockableTabId> = new Set<PtyTabKind>(["claude", "opencode", "codex", "shell"]);

function isPtyTab(tab: DockableTabId): tab is PtyTabKind {
  return PTY_TABS.has(tab);
}

/**
 * Closes a dock tab. A terminal tab also ends its process on the server, so a closed terminal
 * no longer counts as open (for example when quitting to install an update). Closing a running
 * interactive CLI asks first, since that ends its whole session; a plain shell closes directly.
 */
export async function closeDockTab(sessionId: string | undefined, tab: DockableTabId): Promise<void> {
  if (!sessionId) return;
  if (isPtyTab(tab) && tab !== "shell" && isPtyLive(sessionId, tab)) {
    const label = harnessLabel(tab);
    const ok = await confirmGlobally({
      title: `Close the ${label} terminal?`,
      message: `This ends the interactive ${label} session running in it.`,
      confirmLabel: "Close terminal",
      danger: true
    });
    if (!ok) return;
  }
  usePanelStore.getState().moveTab(sessionId, tab, "closed");
  if (!isPtyTab(tab)) return;
  window.cw.closePty(sessionId, tab).catch((err: unknown) => {
    useNotifs.getState().push({
      kind: "error",
      title: "Could not close the terminal",
      message: err instanceof Error ? err.message : String(err)
    });
  });
}
