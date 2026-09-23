import type { DockableTabId, PanelId } from "@cw-code/contracts";
import { AgentsPanel } from "./AgentsPanel.js";
import { FilePanel } from "./FilePanel.js";
import { GitInspectPanel } from "./GitInspectPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { PtyTab } from "./PtyTab.js";
import { useAppStore } from "../stores/appStore.js";
import { tabsInPanel } from "../stores/panelLayout.js";
import { selectSessionPanel, usePanelStore } from "../stores/panelStore.js";

export function ToolContent({ tab, sessionId, panel }: { tab: DockableTabId; sessionId: string; panel: PanelId }) {
  const preview = useAppStore((s) => s.previewBySession[sessionId] ?? null);
  const closePreview = useAppStore((s) => s.closePreview);
  const dockByTab = usePanelStore((s) => selectSessionPanel(s, sessionId).dockByTab);
  const setActive = usePanelStore((s) => s.setActive);
  const moveTab = usePanelStore((s) => s.moveTab);

  if (tab === "files") return <FilePanel sessionId={sessionId} />;
  if (tab === "agents") return <AgentsPanel sessionId={sessionId} />;
  if (tab === "diff") return <GitInspectPanel sessionId={sessionId} />;
  if (tab === "preview") {
    if (!preview) return null;
    return (
      <PreviewPanel
        key={`${preview.sessionId}:${preview.path}:${panel}`}
        sessionId={preview.sessionId}
        path={preview.path}
        basePath={preview.basePath}
        onClose={() => {
          const fallback = tabsInPanel(dockByTab, panel).find((id) => id !== "preview");
          closePreview(sessionId);
          moveTab(sessionId, "preview", "closed");
          if (fallback) setActive(sessionId, panel, fallback);
          else if (panel === "main") setActive(sessionId, "main", "chat");
        }}
      />
    );
  }
  if (tab === "claude" || tab === "opencode" || tab === "codex" || tab === "shell") {
    return <PtyTab key={`${sessionId}-${tab}-${panel}`} sessionId={sessionId} kind={tab} />;
  }
  return null;
}