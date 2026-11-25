import { describe, expect, it } from "bun:test";
import { buildRefLabel } from "./refLabel.js";
import type { HistoryRef, HistoryRefKind } from "@cw-code/contracts";

function ref(kind: HistoryRefKind, name: string, isCurrent = false): HistoryRef {
  const prefix = { local: "refs/heads/", remote: "refs/remotes/", tag: "refs/tags/", stash: "refs/stash" }[kind];
  return {
    fullName: `${prefix}${name}`,
    name,
    kind,
    target: "a".repeat(40),
    isCurrent,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  };
}

describe("buildRefLabel", () => {
  it("returns null without refs", () => {
    expect(buildRefLabel([], false)).toBeNull();
  });

  it("prefers current over local over remote over tag over stash", () => {
    const refs = [ref("stash", "stash@{0}"), ref("tag", "v1"), ref("remote", "origin/x"), ref("local", "dev"), ref("local", "main", true)];
    const label = buildRefLabel(refs, false);
    expect(label?.label).toBe("main");
    expect(label?.isCurrent).toBe(true);
    expect(label?.extra).toBe(4);
    expect(label?.title.split("\n")).toEqual(["main", "dev", "origin/x", "v1", "stash@{0}"]);
    expect(buildRefLabel(refs.slice(0, 4), false)?.label).toBe("dev");
    expect(buildRefLabel(refs.slice(0, 3), false)?.label).toBe("origin/x");
    expect(buildRefLabel(refs.slice(0, 2), false)?.label).toBe("v1");
  });

  it("merges a local branch and its remote twin into one label", () => {
    const label = buildRefLabel([ref("local", "main"), ref("remote", "origin/main")], false);
    expect(label).toMatchObject({ label: "main", kind: "local", hasLocal: true, hasRemote: true, extra: 0 });
  });

  it("keeps a remote branch alone as remote only", () => {
    const label = buildRefLabel([ref("remote", "origin/feat/x")], false);
    expect(label).toMatchObject({ label: "origin/feat/x", kind: "remote", hasLocal: false, hasRemote: true });
  });

  it("does not merge remotes with a different branch name", () => {
    const label = buildRefLabel([ref("local", "main"), ref("remote", "origin/dev")], false);
    expect(label).toMatchObject({ label: "main", hasRemote: false, extra: 1 });
  });

  it("puts a detached HEAD first", () => {
    const label = buildRefLabel([ref("local", "main")], true);
    expect(label).toMatchObject({ label: "HEAD", kind: "head", isCurrent: true, extra: 1 });
  });
});
