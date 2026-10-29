import { Activity, Bot, Eye, GitMerge, MessageSquare, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import type { PrWorkflowIcon } from "@cw-code/contracts";

export const WORKFLOW_ICONS: Record<PrWorkflowIcon, LucideIcon> = {
  eye: Eye,
  activity: Activity,
  message: MessageSquare,
  wrench: Wrench,
  merge: GitMerge,
  bot: Bot,
  sparkle: Sparkles
};

export function workflowIcon(icon: PrWorkflowIcon | undefined): LucideIcon {
  return (icon && WORKFLOW_ICONS[icon]) || Sparkles;
}
