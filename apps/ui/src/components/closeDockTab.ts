import type { DockableTabId } from "@cw-code/contracts";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";
import { useNotifs } from "./Notifications.js";
import { confirmGlobally } from "./GlobalConfirm.js";
import { harnessLabel } from "./toolTabs.js";

type PtyTabKind = "claude" | "opencode" | "codex" | "shell";
type HarnessTabKind = Exclude<PtyTabKind, "shell">;
const PTY_TABS: readonly PtyTabKind[] = ["claude", "opencode", "codex", "shell"];

export function isTerminalTab(tab: DockableTabId): tab is PtyTabKind {
  return (PTY_TABS as readonly DockableTabId[]).includes(tab);
}

/**
 * Interactive CLIs running in these tabs: closing them ends their whole session, so ask first.
 * The server is asked, so a terminal opened by another client or one that exited while its tab
 * was hidden is reported as it really is. If it cannot answer, assume running and ask.
 */
async function runningHarnessTabs(sessionId: string, tabs: readonly PtyTabKind[]): Promise<HarnessTabKind[]> {
  const harnesses = tabs.filter((tab): tab is HarnessTabKind => tab !== "shell");
  const open = await Promise.all(harnesses.map((tab) => window.cw.isPtyOpen(sessionId, tab).catch(() => true)));
  return harnesses.filter((_, index) => open[index]);
}

function confirmEndingHarnesses(harnesses: readonly HarnessTabKind[]): Promise<boolean> {
  if (harnesses.length === 0) return Promise.resolve(true);
  const labels = harnesses.map(harnessLabel);
  const single = labels.length === 1;
  const list = single ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return confirmGlobally({
    title: single ? `Close the ${list} terminal?` : `Close the ${list} terminals?`,
    message: single ? `This ends the interactive ${list} session running in it.` : `This ends the interactive ${list} sessions running in them.`,
    confirmLabel: single ? "Close terminal" : "Close terminals",
    danger: true
  });
}

function endTerminal(sessionId: string, tab: PtyTabKind): void {
  window.cw.closePty(sessionId, tab).catch((err: unknown) => {
    useNotifs.getState().push({
      kind: "error",
      title: "Could not close the terminal",
      message: err instanceof Error ? err.message : String(err)
    });
  });
}

/**
 * Closes a dock tab. A terminal tab also ends its process on the server, so a closed terminal
 * no longer counts as open (for example when quitting to install an update). Closing a running
 * interactive CLI asks first, since that ends its whole session; a plain shell closes directly.
 */
export async function closeDockTab(sessionId: string | undefined, tab: DockableTabId): Promise<void> {
  if (!sessionId) return;
  if (isTerminalTab(tab) && !(await confirmEndingHarnesses(await runningHarnessTabs(sessionId, [tab])))) return;
  usePanelStore.getState().moveTab(sessionId, tab, "closed");
  if (isTerminalTab(tab)) endTerminal(sessionId, tab);
}

/**
 * Resets a session's dock layout, which closes every tab: terminal tabs end their processes the
 * same way `closeDockTab` does, with one confirmation for all running interactive CLIs.
 */
export async function resetDockLayout(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const { dockByTab } = selectSessionPanel(usePanelStore.getState(), sessionId);
  const openTerminals = PTY_TABS.filter((tab) => dockByTab[tab] !== "closed");
  if (!(await confirmEndingHarnesses(await runningHarnessTabs(sessionId, openTerminals)))) return;
  usePanelStore.getState().resetLayout(sessionId);
  for (const tab of openTerminals) endTerminal(sessionId, tab);
}
