import { Bot, Code, Eye, Folder, GitBranch, Orbit, Sparkles, Terminal, type LucideIcon } from "lucide-react";
import type { DockableTabId } from "@cw-code/contracts";
import type { DriverName } from "../cw.js";

export interface ToolTabDef {
  id: DockableTabId;
  title: string;
  Icon: LucideIcon;
  driver?: DriverName;
}

export const TOOL_TABS: ToolTabDef[] = [
  { id: "files", title: "Files", Icon: Folder },
  { id: "agents", title: "Subagents", Icon: Bot },
  { id: "diff", title: "Git diff", Icon: GitBranch },
  { id: "claude", title: "Claude CLI", Icon: Sparkles, driver: "claude" },
  { id: "opencode", title: "OpenCode CLI", Icon: Code, driver: "opencode" },
  { id: "codex", title: "Codex CLI", Icon: Orbit, driver: "codex" },
  { id: "shell", title: "Terminal", Icon: Terminal },
  { id: "preview", title: "Preview", Icon: Eye }
];

export function isHarnessTabId(tab: DockableTabId): tab is DriverName {
  return tab === "claude" || tab === "opencode" || tab === "codex";
}

export function toolTabTitle(tab: DockableTabId): string {
  return TOOL_TABS.find((item) => item.id === tab)?.title ?? tab;
}
export function harnessLabel(driver: DriverName): string {
  if (driver === "claude") return "Claude";
  if (driver === "opencode") return "OpenCode";
  return "Codex";
}
