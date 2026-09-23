import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectSlug, peekClaudeTitle } from "./claudeSessions.js";

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
