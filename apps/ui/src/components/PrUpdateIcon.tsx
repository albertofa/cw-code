import { CircleCheck, CircleX, Eye, GitCommitHorizontal, MessageSquare, type LucideIcon } from "lucide-react";
import type { PrUpdateKind } from "@cw-code/contracts";

const UPDATE_ICONS: Record<PrUpdateKind, { Icon: LucideIcon; tone: string }> = {
  commits: { Icon: GitCommitHorizontal, tone: "neutral" },
  review: { Icon: MessageSquare, tone: "bad" },
  comment: { Icon: MessageSquare, tone: "neutral" },
  checks_failed: { Icon: CircleX, tone: "bad" },
  checks_passed: { Icon: CircleCheck, tone: "ok" },
  review_requested: { Icon: Eye, tone: "info" }
};

export function PrUpdateIcon({ kind }: { kind: PrUpdateKind }) {
  const { Icon, tone } = UPDATE_ICONS[kind];
  return <Icon size={13} className={`pr-dock-update-icon tone-${tone}`} aria-hidden="true" />;
}
