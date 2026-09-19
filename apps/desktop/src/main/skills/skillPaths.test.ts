import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidSkillName,
  canonicalSkillDir,
  codexSkillRoots,
  expandHome,
  getScanRoots,
  harnessSkillRoot,
  isValidSkillName,
  resolveSkillDir,
  shortenHome
} from "./skillPaths.js";

describe("isValidSkillName", () => {
  it("accepts lowercase letters, numbers, and hyphens", () => {
    expect(isValidSkillName("my-skill-123")).toBe(true);
  });

  it("rejects traversal, separators, empty, and overlong names", () => {
    expect(isValidSkillName("..")).toBe(false);
    expect(isValidSkillName("../escape")).toBe(false);
    expect(isValidSkillName("a/b")).toBe(false);
    expect(isValidSkillName("a\\b")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("Upper")).toBe(false);
    expect(isValidSkillName("has space")).toBe(false);
    expect(isValidSkillName("x".repeat(65))).toBe(false);
    expect(isValidSkillName("x".repeat(64))).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands ~/ against the injected home dir", () => {
    expect(expandHome("~/skills", "/home/tester")).toBe(normalize(join("/home/tester", "skills")));
  });

  it("expands a bare ~ to the home dir", () => {
    expect(expandHome("~", "/home/tester")).toBe(normalize("/home/tester"));
  });

  it("leaves absolute paths alone apart from normalization", () => {
    expect(expandHome("/already/absolute", "/home/tester")).toBe(normalize("/already/absolute"));
  });

  it("defaults to the OS homedir", () => {
    expect(expandHome("~/x")).toBe(normalize(join(homedir(), "x")));
  });
});

describe("shortenHome", () => {
  it("shortens posix home prefixes to ~/ ", () => {
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
});

describe("scan roots", () => {
  it("orders claude, codex-current, codex-legacy, then opencode", () => {
    const roots = getScanRoots("/home/tester");
    expect(roots.map((r) => r.harness)).toEqual(["claude", "codex", "codex", "opencode"]);
    expect(roots[0].dir).toBe(join("/home/tester", ".claude", "skills"));
    expect(roots[1].dir).toBe(join("/home/tester", ".agents", "skills"));
    expect(roots[2].dir).toBe(join("/home/tester", ".codex", "skills"));
    expect(roots[3].dir).toBe(join("/home/tester", ".config", "opencode", "skills"));
  });

  it("prefers ~/.agents/skills for codex writes and still scans the legacy root", () => {
    const home = "/home/tester";
    expect(harnessSkillRoot("codex", home)).toBe(codexSkillRoots(home).current);
    expect(codexSkillRoots(home).legacy).toBe(join(home, ".codex", "skills"));
  });
});

describe("resolveSkillDir", () => {
  it("resolves a valid name under its root", () => {
    expect(resolveSkillDir("/root/skills", "my-skill")).toBe(resolve("/root/skills", "my-skill"));
  });

  it("rejects .. and separator names before touching the filesystem", () => {
    expect(() => resolveSkillDir("/root/skills", "..")).toThrow(/invalid skill name/);
    expect(() => resolveSkillDir("/root/skills", "a/b")).toThrow(/invalid skill name/);
    expect(() => assertValidSkillName("")).toThrow(/invalid skill name/);
  });

  it("keeps canonical dirs sandboxed under the app userdata dir", () => {
    const root = process.platform === "win32" ? "C:\\data" : "/data";
    expect(canonicalSkillDir(root, "my-skill")).toBe(join(root, "skills", "my-skill"));
    expect(() => canonicalSkillDir(root, "..")).toThrow(/invalid skill name/);
  });
});
