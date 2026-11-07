import { describe, expect, it } from "bun:test";
import { agentResourceFile, type AgentResourceFile, expandHome, formatFileSubject, looksLikeFileMention, shortenHome, shortenHomeInText, stripMentionMarker } from "./pathDisplay.js";

describe("agentResourceFile", () => {
  const plugin = (name: string, path: string): AgentResourceFile => ({ kind: "plugin", name, path });
  const skill = (name: string, path: string): AgentResourceFile => ({ kind: "skill", name, path });

  it("names the plugin and its relative path for org-synced plugins", () => {
    expect(agentResourceFile("/home/dev/.claude/plugins/synced/1c61a03e-041c_0ace48ba-3b48/ndk~g2/ARCHITECTURE.md")).toEqual(
      plugin("ndk", "ARCHITECTURE.md")
    );
    expect(agentResourceFile("~/.claude/plugins/synced/abc/ndk/skills/plan/SKILL.md")).toEqual(
      plugin("ndk", "skills/plan/SKILL.md")
    );
  });

  it("drops the marketplace and version for cached installs", () => {
    expect(agentResourceFile("/home/dev/.claude/plugins/cache/official/code-review/1.2.0/commands/review.md")).toEqual(
      plugin("code-review", "commands/review.md")
    );
  });

  it("handles marketplace checkouts and Windows paths", () => {
    expect(
      agentResourceFile("C:\\Users\\dev\\.claude\\plugins\\marketplaces\\claude-plugins-official\\plugins\\clangd-lsp\\README.md")
    ).toEqual(plugin("clangd-lsp", "README.md"));
    expect(agentResourceFile("/home/dev/.claude/plugins/marketplaces/official/external_plugins/foo/a/b.md")).toEqual(
      plugin("foo", "a/b.md")
    );
  });

  it("names cw-code's own plugin and skills under any home", () => {
    expect(agentResourceFile("/home/dev/.cw-code/userdata/harness/claude-plugin/skills/cw-code/SKILL.md")).toEqual(
      plugin("cw-code", "skills/cw-code/SKILL.md")
    );
    expect(agentResourceFile("C:\\Users\\dev\\.cw-code-dev\\userdata\\harness\\skills\\cw-code-prs\\SKILL.md")).toEqual(
      skill("cw-code-prs", "SKILL.md")
    );
    expect(agentResourceFile("/srv/cw-home/userdata/harness/claude-plugin/.mcp.json")).toEqual(plugin("cw-code", ".mcp.json"));
    expect(agentResourceFile("/home/dev/.cw-code/userdata/skills/review/SKILL.md")).toEqual(skill("review", "SKILL.md"));
  });

  it("names user and project skills for every harness", () => {
    expect(agentResourceFile("/home/dev/.claude/skills/deploy/SKILL.md")).toEqual(skill("deploy", "SKILL.md"));
    expect(agentResourceFile("/repo/.claude/skills/deploy/refs/steps.md")).toEqual(skill("deploy", "refs/steps.md"));
    expect(agentResourceFile("~/.agents/skills/lint/SKILL.md")).toEqual(skill("lint", "SKILL.md"));
    expect(agentResourceFile("/home/dev/.codex/skills/lint/SKILL.md")).toEqual(skill("lint", "SKILL.md"));
    expect(agentResourceFile("/home/dev/.config/opencode/skills/fmt/SKILL.md")).toEqual(skill("fmt", "SKILL.md"));
    expect(agentResourceFile("/repo/.opencode/skill/fmt/SKILL.md")).toEqual(skill("fmt", "SKILL.md"));
  });

  it("leaves other paths alone", () => {
    expect(agentResourceFile("/home/dev/.claude/plugins/known_marketplaces.json")).toBeNull();
    expect(agentResourceFile("/home/dev/.claude/plugins/synced/abc/manifest.json")).toBeNull();
    expect(agentResourceFile("/home/dev/project/plugins/synced/abc/ndk/x.md")).toBeNull();
    expect(agentResourceFile("/home/dev/.claude/skills/README.md")).toBeNull();
    expect(agentResourceFile("/home/dev/project/userdata/skills/x/SKILL.md")).toBeNull();
    expect(agentResourceFile("/home/dev/project/src/skills/x/SKILL.md")).toBeNull();
  });
});

describe("shortenHome", () => {
  it("shortens posix home prefixes to ~/", () => {
    expect(shortenHome("/home/tester", "/home/tester")).toBe("~");
    expect(shortenHome("/home/tester/projects/cw", "/home/tester")).toBe("~/projects/cw");
  });

  it("leaves paths outside home untouched", () => {
    expect(shortenHome("/home/tester2/projects", "/home/tester")).toBe("/home/tester2/projects");
    expect(shortenHome("/other/place", "/home/tester")).toBe("/other/place");
  });

  it("shortens Windows user-profile prefixes case-insensitively", () => {
    expect(shortenHome("C:\\Users\\tester", "C:\\Users\\tester")).toBe("~");
    expect(shortenHome("C:\\Users\\tester\\Projects\\cw", "C:\\Users\\tester")).toBe("~/Projects/cw");
    expect(shortenHome("c:\\users\\tester\\Projects", "C:\\Users\\tester")).toBe("~/Projects");
  });

  it("does not match sibling profile names", () => {
    expect(shortenHome("C:\\Users\\tester2\\proj", "C:\\Users\\tester")).toBe("C:\\Users\\tester2\\proj");
  });

  it("keeps already-shortened input shortened", () => {
    expect(shortenHome("~", "/home/tester")).toBe("~");
    expect(shortenHome("~/projects", "/home/tester")).toBe("~/projects");
  });

  it("returns input when home is unknown", () => {
    expect(shortenHome("/home/tester/x", "")).toBe("/home/tester/x");
    expect(shortenHome("/home/tester/x")).toBe("/home/tester/x");
  });
});

describe("expandHome", () => {
  it("expands ~/ against the given home dir", () => {
    expect(expandHome("~/skills", "/home/tester")).toBe("/home/tester/skills");
    expect(expandHome("~", "/home/tester")).toBe("/home/tester");
  });
});

describe("formatFileSubject", () => {
  it("prefers the project-relative path", () => {
    expect(formatFileSubject("/proj/src/a.ts", "/proj", "/home/tester")).toBe("src/a.ts");
    expect(formatFileSubject("C:\\proj\\src\\a.ts", "C:\\proj", "C:\\Users\\tester")).toBe("src/a.ts");
  });

  it("strips the @ attachment marker", () => {
    expect(formatFileSubject("@.cw/pastes/x.png", "/proj", "/home/tester")).toBe(".cw/pastes/x.png");
  });

  it("falls back to ~/ when outside the project base", () => {
    expect(formatFileSubject("/home/tester/docs/a.md", "/proj", "/home/tester")).toBe("~/docs/a.md");
    expect(formatFileSubject("C:\\Users\\tester\\docs\\a.md", "C:\\proj", "C:\\Users\\tester")).toBe("~/docs/a.md");
  });

  it("returns the plain path when neither base nor home matches", () => {
    expect(formatFileSubject("@/other/x.png", "/proj", "/home/tester")).toBe("/other/x.png");
    expect(formatFileSubject("rel/path.ts", "/proj", "/home/tester")).toBe("rel/path.ts");
  });
});

describe("shortenHomeInText", () => {
  it("replaces home-absolute paths inside longer text", () => {
    expect(shortenHomeInText("read /home/tester/docs/a.md now", "/home/tester")).toBe("read ~/docs/a.md now");
    expect(shortenHomeInText("run C:\\Users\\tester\\bin\\x", "C:\\Users\\tester")).toBe("run ~/bin/x");
  });

  it("leaves sibling names alone", () => {
    expect(shortenHomeInText("/home/tester2/x", "/home/tester")).toBe("/home/tester2/x");
  });
});

describe("looksLikeFileMention", () => {
  it("matches @-mentions and bare paths without whitespace", () => {
    expect(looksLikeFileMention("@.cw/pastes/x.png")).toBe(true);
    expect(looksLikeFileMention("C:\\Users\\tester\\docs\\a.md")).toBe(true);
    expect(looksLikeFileMention(".cw/pastes/x.png")).toBe(true);
  });

  it("rejects sentences and bare words", () => {
    expect(looksLikeFileMention("Asked 2 questions")).toBe(false);
    expect(looksLikeFileMention("@someone")).toBe(false);
    expect(looksLikeFileMention("")).toBe(false);
  });
});
