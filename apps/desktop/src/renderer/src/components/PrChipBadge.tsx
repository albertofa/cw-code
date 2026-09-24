import { Check, CircleX, Clock, Eye, GitMerge, GitPullRequest, GitPullRequestDraft, MessageSquare, type LucideIcon } from "lucide-react";
import type { PrChip, PrChipIcon } from "./prChip.js";

const PR_CHIP_ICONS: Record<PrChipIcon, LucideIcon> = {
  x: CircleX,
  message: MessageSquare,
  check: Check,
  draft: GitPullRequestDraft,
  eye: Eye,
  clock: Clock,
  merge: GitMerge,
  pr: GitPullRequest
};

export function PrChipBadge({ chip, extra = 0, title }: { chip: PrChip; extra?: number; title?: string }) {
  const Icon = PR_CHIP_ICONS[chip.icon];
  return (
    <span className={`pr-chip tone-${chip.tone}`} title={title ?? chip.title}>
      <Icon size={11} aria-hidden="true" />
      {chip.label}
      {extra > 0 && <span className="pr-chip-more">+{extra}</span>}
    </span>
  );
}
