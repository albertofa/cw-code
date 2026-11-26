import { describe, expect, test } from "bun:test";
import { actionStates, checkoutBlockedReason, type ToolbarActionInput } from "./toolbarActions.js";

const SHA = "a".repeat(40);

const input = (overrides: Partial<ToolbarActionInput> = {}): ToolbarActionInput => ({
  head: { sha: SHA, branch: "main", detached: false },
  currentRef: { upstream: "origin/main", ahead: 2, behind: 3, upstreamGone: false },
  dirtyCount: 4,
  stash: { name: "stash@{0}", subject: "On main: parked" },
  branchTarget: { sha: SHA, selected: false },
  busy: null,
  running: null,
  ...overrides
});

describe("actionStates", () => {
  test("enables every action with ahead and behind badges on a tracked branch", () => {
    const states = actionStates(input());
    expect(Object.values(states).every((state) => !state.disabled)).toBe(true);
    expect(states.pull.badge).toBe(3);
    expect(states.push.badge).toBe(2);
    expect(states.push.title).toBe("Push 2 commits to origin/main (git push)");
    expect(states.pop.title).toBe("Pop stash@{0}: On main: parked");
    expect(states.branch.title).toBe("Create a branch at HEAD (aaaaaaa)");
  });

  test("names the selected commit as the branch target", () => {
    expect(actionStates(input({ branchTarget: { sha: "b".repeat(40), selected: true } })).branch.title).toBe("Create a branch at the selected commit bbbbbbb");
  });

  test("blocks pull and push on a detached HEAD", () => {
    const states = actionStates(input({ head: { sha: SHA, branch: null, detached: true }, currentRef: null }));
    expect(states.pull).toMatchObject({ disabled: true, title: "HEAD is detached — check out a branch to pull" });
    expect(states.push).toMatchObject({ disabled: true, title: "HEAD is detached — check out a branch to push" });
    expect(states.fetch.disabled).toBe(false);
  });

  test("publishes a branch without an upstream or with a gone one", () => {
    const fresh = actionStates(input({ currentRef: { upstream: null, ahead: 0, behind: 0, upstreamGone: false } }));
    expect(fresh.push).toEqual({ disabled: false, title: "Publish main to origin (git push -u origin main)", badge: null });
    expect(fresh.pull).toMatchObject({ disabled: true, title: "main has no upstream branch" });
    const gone = actionStates(input({ currentRef: { upstream: "origin/main", ahead: 0, behind: 0, upstreamGone: true } }));
    expect(gone.push.disabled).toBe(false);
    expect(gone.pull).toMatchObject({ disabled: true, title: "origin/main no longer exists on the remote" });
  });

  test("blocks push when nothing is ahead and hides empty badges", () => {
    const states = actionStates(input({ currentRef: { upstream: "origin/main", ahead: 0, behind: 0, upstreamGone: false } }));
    expect(states.push).toMatchObject({ disabled: true, badge: null });
    expect(states.push.title).toStartWith("Nothing to push");
    expect(states.pull).toMatchObject({ disabled: false, badge: null });
  });

  test("blocks stash on a clean tree but not on an unknown one", () => {
    expect(actionStates(input({ dirtyCount: 0 })).stash).toMatchObject({ disabled: true, title: "Nothing to stash — the working tree is clean" });
    expect(actionStates(input({ dirtyCount: null })).stash).toMatchObject({ disabled: false, title: "Stash the uncommitted changes, including untracked files" });
    expect(actionStates(input({ dirtyCount: 1 })).stash.title).toBe("Stash 1 changed file, including untracked files");
  });

  test("blocks pop without a stash", () => {
    expect(actionStates(input({ stash: null })).pop).toMatchObject({ disabled: true, title: "No stash to pop" });
  });

  test("blocks commit-based actions in a repository without commits", () => {
    const states = actionStates(input({ head: { sha: null, branch: "main", detached: false }, currentRef: null, branchTarget: null }));
    expect(states.push.disabled).toBe(true);
    expect(states.branch.disabled).toBe(true);
    expect(states.stash.disabled).toBe(true);
  });

  test("blocks everything but fetch while the history loads", () => {
    const states = actionStates(input({ head: null }));
    expect(states.fetch.disabled).toBe(false);
    for (const id of ["pull", "push", "branch", "stash", "pop"] as const) expect(states[id].disabled).toBe(true);
  });

  test("blocks every action while another one runs and keeps the badges", () => {
    const states = actionStates(input({ busy: "Pulling" }));
    expect(Object.values(states).every((state) => state.disabled && state.title === "Wait for “Pulling” to finish")).toBe(true);
    expect(states.pull.badge).toBe(3);
    expect(states.push.badge).toBe(2);
  });

  test("blocks checkout-changing actions while a session runs a turn in the checkout", () => {
    const states = actionStates(input({ running: "Fix login" }));
    const reason = "Fix login is running a turn in this checkout — wait for it to finish";
    for (const id of ["fetch", "pull", "push", "stash", "pop"] as const) expect(states[id]).toMatchObject({ disabled: true, title: reason });
    expect(states.pull.badge).toBe(3);
    expect(states.push.badge).toBe(2);
    expect(states.branch).toMatchObject({ disabled: false, title: "Create a branch at HEAD (aaaaaaa) — it can't be checked out until Fix login finishes its turn" });
    expect(checkoutBlockedReason({ running: "Fix login" })).toBe(reason);
    expect(checkoutBlockedReason({ running: null })).toBeNull();
  });

  test("keeps a more lasting reason over the running turn", () => {
    const states = actionStates(input({ running: "Fix login", stash: null, dirtyCount: 0 }));
    expect(states.pop.title).toBe("No stash to pop");
    expect(states.stash.title).toBe("Nothing to stash — the working tree is clean");
  });

  test("lets a running action take precedence over a running turn", () => {
    const states = actionStates(input({ running: "Fix login", busy: "Fetching" }));
    expect(Object.values(states).every((state) => state.disabled && state.title === "Wait for “Fetching” to finish")).toBe(true);
  });
});
