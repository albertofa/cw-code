import type { HistoryCommitPull } from "@cw-code/contracts";

function upstreamBranch(upstream: string | null): string | null {
  if (!upstream) return null;
  const slash = upstream.indexOf("/");
  return slash === -1 ? upstream : upstream.slice(slash + 1);
}

// The pull requests of a checked-out branch: those containing its tip whose head is that branch
// (or the branch it tracks). A tip that only reached the branch through other PRs, like the tip of
// main, belongs to none.
export function branchPulls(pulls: HistoryCommitPull[], branch: string, upstream: string | null): HistoryCommitPull[] {
  const names = new Set([branch, upstreamBranch(upstream)].filter((name): name is string => name !== null && name.length > 0));
  return pulls.filter((pull) => names.has(pull.headRefName));
}
