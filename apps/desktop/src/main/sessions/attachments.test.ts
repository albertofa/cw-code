import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAttachments } from "./attachments.js";

function makeDirs() {
  const projectRoot = mkdtempSync(join(tmpdir(), "cw-att-proj-"));
  const cwd = mkdtempSync(join(tmpdir(), "cw-att-cwd-"));
  return { projectRoot, cwd };
}

describe("resolveAttachments", () => {
  it("keeps rel unchanged when it exists in cwd", () => {
    const { projectRoot, cwd } = makeDirs();
    writeFileSync(join(cwd, "a.png"), "cwd");
    expect(resolveAttachments(projectRoot, cwd, ["a.png"])).toEqual(["a.png"]);
    expect(readFileSync(join(cwd, "a.png"), "utf8")).toBe("cwd");
  });

  it("copies from project root into cwd when missing there", () => {
    const { projectRoot, cwd } = makeDirs();
    mkdirSync(join(projectRoot, "sub"), { recursive: true });
    writeFileSync(join(projectRoot, "sub", "b.bin"), Buffer.from([1, 2, 3]));
    expect(resolveAttachments(projectRoot, cwd, ["sub/b.bin"])).toEqual(["sub/b.bin"]);
    expect(existsSync(join(cwd, "sub", "b.bin"))).toBe(true);
    expect(readFileSync(join(cwd, "sub", "b.bin"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("drops missing attachments with a warning", () => {
    const { projectRoot, cwd } = makeDirs();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveAttachments(projectRoot, cwd, ["missing.png"])).toEqual([]);
    expect(warn).toHaveBeenCalledWith("attachment not found, skipped: missing.png");
    warn.mockRestore();
  });

  it("drops escaping paths", () => {
    const { projectRoot, cwd } = makeDirs();
    const outside = mkdtempSync(join(tmpdir(), "cw-att-out-"));
    writeFileSync(join(outside, "x.png"), "secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveAttachments(projectRoot, cwd, ["../x.png", outside])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(existsSync(join(cwd, "x.png"))).toBe(false);
    warn.mockRestore();
  });

  it("returns empty array for empty input", () => {
    const { projectRoot, cwd } = makeDirs();
    expect(resolveAttachments(projectRoot, cwd, [])).toEqual([]);
  });

  it("preserves order and does not mutate input", () => {
    const { projectRoot, cwd } = makeDirs();
    writeFileSync(join(projectRoot, "a.png"), "a");
    writeFileSync(join(cwd, "b.png"), "b");
    const input = ["a.png", "nope.png", "b.png"];
    expect(resolveAttachments(projectRoot, cwd, input)).toEqual(["a.png", "b.png"]);
    expect(input).toEqual(["a.png", "nope.png", "b.png"]);
  });
});
