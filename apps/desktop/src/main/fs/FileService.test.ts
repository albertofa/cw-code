import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService } from "./FileService.js";

describe("FileService sandbox", () => {
  const svc = new FileService();
  const root = join(tmpdir(), "cw-code-probe");

  it("rejects paths escaping the project root", () => {
    expect(() => svc.readFile(root, "../outside.txt")).toThrow(/escapes project root/);
    expect(() => svc.saveFile(root, "..\\outside.txt", "x")).toThrow(/escapes project root/);
  });

  it("lists files without touching parent dirs", () => {
    const listed = svc.listFiles(mkdtempSync(join(tmpdir(), "cw-list-")));
    expect(Array.isArray(listed)).toBe(true);
  });

  it("reads outside files with guards", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-outside-"));
    const file = join(dir, "note.md");
    writeFileSync(file, "# hi", "utf8");
    expect(svc.readOutsideFile(file)).toBe("# hi");
    expect(() => svc.readOutsideFile(join(dir, "missing.md"))).toThrow(/not found/);
    expect(() => svc.readOutsideFile(dir)).toThrow(/not a file/);
    expect(() => svc.readOutsideFile("relative.md")).toThrow(/absolute path required/);
  });
});
