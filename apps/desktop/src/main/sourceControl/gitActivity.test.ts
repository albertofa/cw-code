import { describe, expect, it } from "vitest";
import { classifyToolCall, gitWatchEventKind, REMOTE_EFFECT_RE } from "./gitActivity.js";

const LOCAL = { refreshLocal: true, remoteEffect: false };
const REMOTE = { refreshLocal: true, remoteEffect: true };
const NONE = { refreshLocal: false, remoteEffect: false };

describe("classifyToolCall", () => {
  it("treats each driver's shell tool as a local refresh", () => {
    expect(classifyToolCall("Bash", { command: "git status" })).toEqual(LOCAL);
    expect(classifyToolCall("bash", { command: "git status" })).toEqual(LOCAL);
    expect(classifyToolCall("shell", { command: ["git", "status"], cwd: "/repo" })).toEqual(LOCAL);
  });

  it("flags git push and gh pr mutations as remote effects", () => {
    expect(classifyToolCall("Bash", { command: "git push origin feature" })).toEqual(REMOTE);
    expect(classifyToolCall("bash", { command: "cd app && git push -u origin x" })).toEqual(REMOTE);
    expect(classifyToolCall("Bash", { command: 'gh pr create --title "x"' })).toEqual(REMOTE);
    expect(classifyToolCall("Bash", { command: "gh pr merge 12 --squash" })).toEqual(REMOTE);
    expect(classifyToolCall("Bash", { command: "gh pr ready" })).toEqual(REMOTE);
    expect(classifyToolCall("Bash", { command: "gh api -X POST repos/o/r/pulls -f title=x" })).toEqual(REMOTE);
  });

  it("joins array commands before matching", () => {
    expect(classifyToolCall("shell", { command: ["git", "push", "origin", "x"] })).toEqual(REMOTE);
    expect(classifyToolCall("PowerShell", { command: "git -C C:\\repo push" })).toEqual(REMOTE);
    expect(classifyToolCall("Bash", { command: "git -c core.hooksPath=/dev/null push" })).toEqual(REMOTE);
    expect(classifyToolCall("shell", { command: ["bash", "-lc", "gh pr create"] })).toEqual(REMOTE);
    expect(classifyToolCall("shell", { command: ["ls", 3, null] })).toEqual(LOCAL);
  });

  it("keeps non-publishing git commands local", () => {
    expect(classifyToolCall("Bash", { command: "git status" })).toEqual(LOCAL);
    expect(classifyToolCall("Bash", { command: "git commit -m x" })).toEqual(LOCAL);
    expect(classifyToolCall("Bash", { command: "gh pr view 3" })).toEqual(LOCAL);
    expect(classifyToolCall("Bash", { command: "gh pr list" })).toEqual(LOCAL);
    expect(classifyToolCall("Bash", { command: "echo git pushing" })).toEqual(LOCAL);
  });

  it("refreshes locally for edit tools without remote effect", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit", "patch", "apply_patch", "edit"]) {
      expect(classifyToolCall(name, { file_path: "a.ts" })).toEqual(LOCAL);
    }
    expect(classifyToolCall("Edit", { command: "git push" })).toEqual(LOCAL);
  });

  it("ignores unknown tools", () => {
    expect(classifyToolCall("Read", { file_path: "a.ts" })).toEqual(NONE);
    expect(classifyToolCall("WebFetch", { url: "x" })).toEqual(NONE);
    expect(classifyToolCall("", {})).toEqual(NONE);
  });

  it("tolerates non-object and malformed input", () => {
    expect(classifyToolCall("Bash", null)).toEqual(LOCAL);
    expect(classifyToolCall("Bash", undefined)).toEqual(LOCAL);
    expect(classifyToolCall("Bash", "git push")).toEqual(LOCAL);
    expect(classifyToolCall("Bash", 42)).toEqual(LOCAL);
    expect(classifyToolCall("Bash", { command: 7 })).toEqual(LOCAL);
    expect(classifyToolCall("Bash", {})).toEqual(LOCAL);
    expect(classifyToolCall("Read", null)).toEqual(NONE);
  });
});

describe("REMOTE_EFFECT_RE", () => {
  it("is not stateful across calls", () => {
    expect(REMOTE_EFFECT_RE.test("git push")).toBe(true);
    expect(REMOTE_EFFECT_RE.test("git push")).toBe(true);
  });

  it("does not match gh api calls to other endpoints", () => {
    expect(REMOTE_EFFECT_RE.test("gh api repos/o/r/issues")).toBe(false);
    expect(REMOTE_EFFECT_RE.test("gh api graphql -f query=x")).toBe(false);
  });
});

describe("gitWatchEventKind", () => {
  const relevant = [
    "HEAD",
    "packed-refs",
    "config",
    "refs/heads/main",
    "refs/heads/feature/nested",
    "refs/remotes/origin/main",
    "refs/tags/v1",
    "refs\\heads\\main",
    "./HEAD",
  ];
  const ignored = [
    "",
    "index",
    "index.lock",
    "HEAD.lock",
    "config.lock",
    "packed-refs.lock",
    "refs/heads/main.lock",
    "objects/ab/cdef",
    "objects/pack/pack-1.idx",
    "logs/HEAD",
    "logs/refs/heads/main",
    "hooks/pre-commit",
    "hooks\\pre-commit",
    "FETCH_HEAD",
    "ORIG_HEAD",
    "COMMIT_EDITMSG",
    "refs",
    "refs/stash",
    "worktrees/x/HEAD",
  ];

  it.each(relevant)("treats %j as relevant", (path) => {
    expect(gitWatchEventKind(path)).toBe("relevant");
  });

  it.each(ignored)("treats %j as ignored", (path) => {
    expect(gitWatchEventKind(path)).toBe("ignored");
  });

  it("only ignores objects, logs and hooks at the top level", () => {
    expect(gitWatchEventKind("refs/heads/logs/topic")).toBe("relevant");
    expect(gitWatchEventKind("refs/heads/objects")).toBe("relevant");
  });
});
