import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedSegments, resolveFeedFile } from "./feedSandbox.ts";

async function tryFileSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  }
}

describe("feedSegments", () => {
  it.each([
    "/latest.yml",
    "/alpha.yml",
    "/cw-code-updatetest-Setup-0.0.1-alpha.9001-x64.exe",
    "/cw-code-updatetest-Setup-0.0.1-alpha.9001-x64.exe.blockmap",
    "/nested/dir/file.bin",
    "/encoded%2Ddash.yml"
  ])("accepts %s", (path) => {
    expect(feedSegments(path).ok).toBe(true);
  });

  it.each([
    ["relative path", "latest.yml"],
    ["root", "/"],
    ["parent segment", "/../secret.txt"],
    ["inner parent segment", "/a/../../secret.txt"],
    ["current segment", "/./latest.yml"],
    ["encoded dots", "/%2e%2e/secret.txt"],
    ["encoded slash", "/..%2fsecret.txt"],
    ["encoded backslash", "/..%5Csecret.txt"],
    ["double-encoded dots", "/%252e%252e/secret.txt"],
    ["backslash", "/a\\b.txt"],
    ["drive letter", "/C:/Windows/win.ini"],
    ["UNC-style double slash", "//server/share/file"],
    ["trailing slash", "/dir/"],
    ["encoded NUL", "/latest.yml%00.exe"],
    ["malformed escape", "/%E0%A4%A"],
    ["dot file", "/.env"],
    ["trailing dot alias", "/latest.yml."],
    ["device name", "/nul"],
    ["device name with extension", "/CON.txt"],
    ["alternate data stream", "/latest.yml:stream"],
    ["space", "/latest yml"]
  ])("rejects %s", (_label, path) => {
    expect(feedSegments(path).ok).toBe(false);
  });

  it("rejects overlong paths", () => {
    expect(feedSegments(`/${"a".repeat(600)}`).ok).toBe(false);
  });
});

describe("resolveFeedFile", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "cw-feed-sandbox-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "latest.yml"), "version: 1.0.0\n");
    await writeFile(join(root, "sub", "file.bin"), "inside");
    await writeFile(join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("resolves files inside the root with their size", async () => {
    const result = await resolveFeedFile(root, "/latest.yml");
    expect(result).toMatchObject({ ok: true, relativePath: "latest.yml", size: 15 });
    expect(await resolveFeedFile(root, "/sub/file.bin")).toMatchObject({ ok: true, relativePath: "sub/file.bin" });
  });

  it("returns 404 for missing files and directories", async () => {
    expect(await resolveFeedFile(root, "/missing.yml")).toMatchObject({ ok: false, status: 404 });
    expect(await resolveFeedFile(root, "/sub")).toMatchObject({ ok: false, status: 404 });
    expect(await resolveFeedFile(root, "/latest.yml/child")).toMatchObject({ ok: false, status: 404 });
  });

  it("returns 400 for traversal attempts before touching the filesystem", async () => {
    expect(await resolveFeedFile(root, "/../outside/secret.txt")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveFeedFile(root, "/%2e%2e/outside/secret.txt")).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a junction that points outside the root", async () => {
    await symlink(outside, join(root, "escape"), "junction");
    expect(await resolveFeedFile(root, "/escape/secret.txt")).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a file symlink that points outside the root", async () => {
    if (!(await tryFileSymlink(join(outside, "secret.txt"), join(root, "secret.txt")))) return;
    expect(await resolveFeedFile(root, "/secret.txt")).toMatchObject({ ok: false, status: 403 });
  });

  it("allows links that stay inside the root", async () => {
    await symlink(join(root, "sub"), join(root, "alias"), "junction");
    expect(await resolveFeedFile(root, "/alias/file.bin")).toMatchObject({ ok: true, relativePath: "alias/file.bin" });
  });

  it("works when the root itself is reached through a link", async () => {
    const linkedRoot = join(base, "linked-root");
    await symlink(root, linkedRoot, "junction");
    expect(await resolveFeedFile(linkedRoot, "/latest.yml")).toMatchObject({ ok: true });
    await symlink(outside, join(root, "escape"), "junction");
    expect(await resolveFeedFile(linkedRoot, "/escape/secret.txt")).toMatchObject({ ok: false, status: 403 });
  });
});
