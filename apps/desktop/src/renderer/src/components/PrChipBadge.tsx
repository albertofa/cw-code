import { Check, CircleX, Clock, Eye, GitMerge, GitPullRequestDraft, MessageSquare, type LucideIcon } from "lucide-react";
import type { PrChip, PrChipIcon } from "./prChip.js";

const PR_CHIP_ICONS: Record<PrChipIcon, LucideIcon> = {
  x: CircleX,
  message: MessageSquare,
  check: Check,
  draft: GitPullRequestDraft,
  eye: Eye,
  clock: Clock,
  merge: GitMerge
};

export function PrChipBadge({ chip }: { chip: PrChip }) {
  const Icon = PR_CHIP_ICONS[chip.icon];
  return (
    <span className={`pr-chip tone-${chip.tone}`} title={chip.title}>
      <Icon size={11} aria-hidden="true" />
      {chip.label}
    </span>
  );
}
