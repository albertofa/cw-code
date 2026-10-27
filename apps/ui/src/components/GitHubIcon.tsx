import {
  AtSign,
  Bookmark,
  BookMarked,
  Building2,
  Circle,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CirclePlay,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  History,
  Inbox,
  Loader,
  Milestone,
  Pencil,
  TriangleAlert,
  User,
  UserCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";
import type { GitHubKind } from "../cw.js";

const ICONS: Record<string, LucideIcon> = {
  AtSign,
  Bookmark,
  BookMarked,
  Building2,
  Circle,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CirclePlay,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  History,
  Inbox,
  Loader,
  Milestone,
  Pencil,
  TriangleAlert,
  User,
  UserCheck,
  Workflow
};

export const KIND_ICONS: Record<GitHubKind, LucideIcon> = { pr: GitPullRequest, issue: CircleDot, run: CirclePlay };

const VALUE_ICONS: Record<string, Record<string, string>> = {
  is: { pr: "GitPullRequest", issue: "CircleDot", run: "CirclePlay" },
  status: {
    success: "CircleCheck",
    failure: "CircleX",
    pending: "Loader",
    in_progress: "Loader",
    queued: "CircleDashed",
    cancelled: "CircleSlash"
  }
};

const KEY_ICONS: Record<string, string> = {
  repo: "BookMarked",
  org: "Building2",
  milestone: "Milestone",
  workflow: "Workflow",
  branch: "GitBranch"
};

export function valueIconName(key: string, value: string): string | null {
  return VALUE_ICONS[key]?.[value] ?? KEY_ICONS[key] ?? null;
}

export function NamedIcon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const Icon = ICONS[name] ?? Circle;
  return <Icon size={size} aria-hidden="true" className={className} />;
}
