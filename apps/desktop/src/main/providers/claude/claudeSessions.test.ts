import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug, claudeTranscriptProjectDir, listNativeClaudeSessions, peekClaudeTitle, summarizeClaudeTranscript } from "./claudeSessions.js";

describe("claudeProjectSlug", () => {
  it("matches Claude's directory naming", () => {
    expect(claudeProjectSlug("C:\\Projects\\cmutil-nuget")).toBe("C--Projects-cmutil-nuget");
  });

  it("ignores trailing separators", () => {
    expect(claudeProjectSlug("C:\\Projects\\cmutil-nuget\\")).toBe("C--Projects-cmutil-nuget");
    expect(claudeProjectSlug("C:/Projects/cmutil-nuget/")).toBe("C--Projects-cmutil-nuget");
  });

  it("peeks the first user prompt as title", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-peek-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "system", message: { content: "x" } }),
        JSON.stringify({ type: "user", isMeta: true, message: { content: "caveat" } }),
        JSON.stringify({ type: "user", uuid: "u1", message: { content: "fix the login bug please" } })
      ].join("\n"),
      "utf8"
    );
    expect(peekClaudeTitle(file)).toBe("fix the login bug please");
    expect(peekClaudeTitle(join(dir, "missing.jsonl"))).toBeNull();
  });

  it("titles a slash-command session with /name args instead of the raw transcript line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-peek-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: {
          content:
            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"
        }
      }),
      "utf8"
    );
    expect(peekClaudeTitle(file)).toBe("/compact");
  });
});

describe("claudeTranscriptProjectDir", () => {
  function projectsWith(slug: string, cursor: string): string {
    const projects = mkdtempSync(join(tmpdir(), "cw-projects-"));
    mkdirSync(join(projects, slug));
    writeFileSync(join(projects, slug, `${cursor}.jsonl`), "{}\n", "utf8");
    return projects;
  }

  it("uses the cwd's project dir when the transcript is there", () => {
    const projects = projectsWith("C--repo", "abc");
    expect(claudeTranscriptProjectDir("C:/repo", "abc", projects)).toBe(join(projects, "C--repo"));
  });

  it("finds a transcript written under a removed worktree's project dir", () => {
    const projects = projectsWith("C--wt-sess-1", "def");
    mkdirSync(join(projects, "C--repo"));
    expect(claudeTranscriptProjectDir("C:/repo", "def", projects)).toBe(join(projects, "C--wt-sess-1"));
  });

  it("falls back to the cwd's project dir when no transcript exists", () => {
    const projects = projectsWith("C--other", "ghi");
    expect(claudeTranscriptProjectDir("C:/repo", "missing", projects)).toBe(join(projects, "C--repo"));
  });
});

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

describe("summarizeClaudeTranscript", () => {
  const prompt = { type: "user", message: { content: "Fix the login redirect" }, cwd: "C:\repo", gitBranch: "HEAD", timestamp: "2026-09-04T14:00:10.548Z" };

  it("reads cwd, first prompt, creation time and the latest real branch", () => {
    const head = jsonl({ type: "permission-mode", permissionMode: "auto" }, prompt, { type: "assistant", cwd: "C:\repo", gitBranch: "feat/login" });
    expect(summarizeClaudeTranscript(head, "")).toEqual({
      cwd: "C:\repo",
      title: "Fix the login redirect",
      gitBranch: "feat/login",
      createdAt: Date.parse("2026-09-04T14:00:10.548Z")
    });
  });

  it("prefers a custom title over the AI title over the first prompt", () => {
    const tail = jsonl({ type: "ai-title", aiTitle: "Login redirect fix" });
    expect(summarizeClaudeTranscript(jsonl(prompt), tail)?.title).toBe("Login redirect fix");
    const renamed = jsonl({ type: "ai-title", aiTitle: "Login redirect fix" }, { type: "custom-title", customTitle: "Auth work" });
    expect(summarizeClaudeTranscript(jsonl(prompt), renamed)?.title).toBe("Auth work");
  });

  it("skips sidechain entries and tolerates truncated lines", () => {
    const head = `${jsonl({ type: "user", isSidechain: true, message: { content: "subagent" }, cwd: "C:\other" }, prompt)}\n{"type":"assis`;
    expect(summarizeClaudeTranscript(head, "")).toMatchObject({ cwd: "C:\repo", title: "Fix the login redirect" });
  });

  it("returns null without a conversation or a working directory", () => {
    expect(summarizeClaudeTranscript(jsonl({ type: "file-history-snapshot", cwd: "C:\repo" }), "")).toBeNull();
    expect(summarizeClaudeTranscript(jsonl({ type: "user", message: { content: "hi" } }), "")).toBeNull();
  });
});

describe("listNativeClaudeSessions", () => {
  it("lists transcripts across every project folder and skips agent files", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-native-"));
    mkdirSync(join(root, "C--a"));
    mkdirSync(join(root, "C--b"));
    writeFileSync(join(root, "C--a", "one.jsonl"), jsonl({ type: "user", message: { content: "first" }, cwd: "C:\a" }));
    writeFileSync(join(root, "C--b", "two.jsonl"), jsonl({ type: "user", message: { content: "second" }, cwd: "C:\b" }));
    writeFileSync(join(root, "C--b", "agent-x.jsonl"), jsonl({ type: "user", message: { content: "agent" }, cwd: "C:\b" }));
    writeFileSync(join(root, "C--b", "empty.jsonl"), "");

    const sessions = await listNativeClaudeSessions(root);

    expect(sessions.map((s) => [s.resumeCursor, s.cwd, s.title]).sort()).toEqual([
      ["one", "C:\a", "first"],
      ["two", "C:\b", "second"]
    ]);
    expect(sessions.every((s) => s.driver === "claude")).toBe(true);
  });

  it("returns nothing when Claude has no projects folder", async () => {
    expect(await listNativeClaudeSessions(join(tmpdir(), "claude-native-missing-dir"))).toEqual([]);
  });
});
