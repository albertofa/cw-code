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

  it("lists every ref as an entry in display order with its checkout target", () => {
    const refs = [ref("tag", "v1"), ref("remote", "origin/main"), ref("local", "main"), ref("remote", "origin/feat"), ref("local", "dev", true)];
    const label = buildRefLabel(refs, false);
    expect(label?.entries.map((entry) => [entry.name, entry.kind, entry.checkout, entry.hasLocal, entry.hasRemote, entry.isCurrent])).toEqual([
      ["dev", "local", "dev", true, false, true],
      ["main", "local", "main", true, true, false],
      ["origin/feat", "remote", "origin/feat", false, true, false],
      ["v1", "tag", null, false, false, false]
    ]);
  });

  it("gives a detached HEAD entry no checkout target", () => {
    expect(buildRefLabel([], true)?.entries).toEqual([
      { key: "HEAD", name: "HEAD", checkout: null, localElsewhere: false, kind: "head", isCurrent: true, hasLocal: false, hasRemote: false }
    ]);
  });

  it("checks out the existing local branch when a remote branch's local twin is on another commit", () => {
    const label = buildRefLabel([ref("remote", "origin/testing"), ref("remote", "origin/main")], false, { names: new Set(["testing", "main"]), current: "main" });
    expect(label?.entries.map((entry) => [entry.name, entry.checkout, entry.localElsewhere])).toEqual([
      ["origin/main", null, true],
      ["origin/testing", "testing", true]
    ]);
  });
});
