import type { HistoryHead, HistoryRef } from "@cw-code/contracts";

export type ToolbarActionId = "fetch" | "pull" | "push" | "branch" | "stash" | "pop";

export interface ToolbarActionState {
  disabled: boolean;
  title: string;
  badge: number | null;
}

export interface ToolbarActionInput {
  head: HistoryHead | null;
  currentRef: Pick<HistoryRef, "upstream" | "ahead" | "behind" | "upstreamGone"> | null;
  dirtyCount: number | null;
  stash: { name: string; subject: string } | null;
  branchTarget: { sha: string; selected: boolean } | null;
  busy: string | null;
  running: string | null;
}

const LOADING = "The history is still loading";
const NO_COMMITS = "No commits yet";

const enabled = (title: string, badge: number | null = null): ToolbarActionState => ({ disabled: false, title, badge });
const blocked = (title: string, badge: number | null = null): ToolbarActionState => ({ disabled: true, title, badge });
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const short = (sha: string): string => sha.slice(0, 7);
const CHECKOUT_ACTIONS: readonly ToolbarActionId[] = ["fetch", "pull", "push", "stash", "pop"];

export function checkoutBlockedReason({ running }: Pick<ToolbarActionInput, "running">): string | null {
  return running === null ? null : `${running} is running a turn in this checkout — wait for it to finish`;
}

function pullState({ head, currentRef }: ToolbarActionInput): ToolbarActionState {
  if (!head) return blocked(LOADING);
  if (!head.branch) return blocked("HEAD is detached — check out a branch to pull");
  if (!currentRef?.upstream) return blocked(`${head.branch} has no upstream branch`);
  if (currentRef.upstreamGone) return blocked(`${currentRef.upstream} no longer exists on the remote`);
  const badge = currentRef.behind > 0 ? currentRef.behind : null;
  return enabled(`Fast-forward ${head.branch} from ${currentRef.upstream} (git pull --ff-only)`, badge);
}

function pushState({ head, currentRef }: ToolbarActionInput): ToolbarActionState {
  if (!head) return blocked(LOADING);
  if (!head.branch) return blocked("HEAD is detached — check out a branch to push");
  if (!head.sha) return blocked(`${NO_COMMITS} — nothing to push`);
  if (!currentRef?.upstream || currentRef.upstreamGone) return enabled(`Publish ${head.branch} to origin (git push -u origin ${head.branch})`);
  if (currentRef.ahead === 0) return blocked(`Nothing to push — ${head.branch} has no commits that ${currentRef.upstream} lacks`);
  return enabled(`Push ${plural(currentRef.ahead, "commit")} to ${currentRef.upstream} (git push)`, currentRef.ahead);
}

function branchState({ head, branchTarget }: ToolbarActionInput): ToolbarActionState {
  if (!head) return blocked(LOADING);
  if (!branchTarget) return blocked(`${NO_COMMITS} — nothing to branch from`);
  const at = branchTarget.selected ? `the selected commit ${short(branchTarget.sha)}` : `HEAD (${short(branchTarget.sha)})`;
  return enabled(`Create a branch at ${at}`);
}

function stashState({ head, dirtyCount }: ToolbarActionInput): ToolbarActionState {
  if (!head) return blocked(LOADING);
  if (!head.sha) return blocked(`${NO_COMMITS} — make a first commit before stashing`);
  if (dirtyCount === 0) return blocked("Nothing to stash — the working tree is clean");
  const what = dirtyCount === null ? "the uncommitted changes" : plural(dirtyCount, "changed file");
  return enabled(`Stash ${what}, including untracked files`);
}

function popState({ head, stash }: ToolbarActionInput): ToolbarActionState {
  if (!head) return blocked(LOADING);
  if (!stash) return blocked("No stash to pop");
  return enabled(`Pop ${stash.name}${stash.subject ? `: ${stash.subject}` : ""}`);
}

export function actionStates(input: ToolbarActionInput): Record<ToolbarActionId, ToolbarActionState> {
  const states: Record<ToolbarActionId, ToolbarActionState> = {
    fetch: enabled("Fetch from origin and prune deleted branches (git fetch --prune origin)"),
    pull: pullState(input),
    push: pushState(input),
    branch: branchState(input),
    stash: stashState(input),
    pop: popState(input)
  };
  if (input.busy !== null) {
    const wait = `Wait for “${input.busy}” to finish`;
    for (const id of Object.keys(states) as ToolbarActionId[]) states[id] = blocked(wait, states[id].badge);
    return states;
  }
  const running = checkoutBlockedReason(input);
  if (running === null) return states;
  for (const id of CHECKOUT_ACTIONS) {
    if (!states[id].disabled) states[id] = blocked(running, states[id].badge);
  }
  if (!states.branch.disabled) states.branch = enabled(`${states.branch.title} — it can't be checked out until ${input.running} finishes its turn`);
  return states;
}
