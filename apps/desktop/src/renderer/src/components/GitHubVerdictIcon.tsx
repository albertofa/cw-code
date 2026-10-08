import {
  Check,
  Circle,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  Clock,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader,
  MessageSquareDiff,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";
import { diffBlocks, type Verdict, type VerdictIcon } from "./githubRowModel.js";

const VERDICT_ICONS: Record<VerdictIcon, LucideIcon> = {
  "git-merge": GitMerge,
  "git-pull-request": GitPullRequest,
  "git-pull-request-closed": GitPullRequestClosed,
  "git-pull-request-draft": GitPullRequestDraft,
  "triangle-alert": TriangleAlert,
  "circle-x": CircleX,
  circle: Circle,
  "circle-check": CircleCheck,
  "circle-check-big": CircleCheckBig,
  "circle-slash": CircleSlash,
  "circle-dot": CircleDot,
  "circle-dashed": CircleDashed,
  "message-square-diff": MessageSquareDiff,
  loader: Loader,
  eye: Eye,
  clock: Clock,
  check: Check
};

export function VerdictGlyph({
  verdict,
  size = 13,
  toneClass = true
}: {
  verdict: Pick<Verdict, "icon" | "tone" | "spin">;
  size?: number;
  toneClass?: boolean;
}) {
  const Icon = VERDICT_ICONS[verdict.icon];
  const className = [toneClass ? `tone-${verdict.tone}` : "", verdict.spin ? "pr-inbox-spin" : ""].filter(Boolean).join(" ");
  return <Icon size={size} aria-hidden="true" className={className || undefined} />;
}

export function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const blocks = diffBlocks(additions, deletions);
  return (
    <span className="hub-diffbar" aria-hidden="true">
      {Array.from({ length: blocks.add }, (_, i) => (
        <i key={`a${i}`} className="a" />
      ))}
      {Array.from({ length: blocks.del }, (_, i) => (
        <i key={`d${i}`} className="d" />
      ))}
      {Array.from({ length: blocks.neutral }, (_, i) => (
        <i key={`n${i}`} />
      ))}
    </span>
  );
}
