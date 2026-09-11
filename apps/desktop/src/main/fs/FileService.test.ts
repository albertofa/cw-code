import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService, pasteImageExt, pasteImageName } from "./FileService.js";

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

describe("paste image helpers", () => {
  it("maps mimes to extensions and rejects others", () => {
    expect(pasteImageExt("image/png")).toBe("png");
    expect(pasteImageExt("image/jpeg")).toBe("jpg");
    expect(pasteImageExt("image/webp")).toBe("webp");
    expect(pasteImageExt("image/gif")).toBe("gif");
    expect(() => pasteImageExt("image/svg+xml")).toThrow(/unsupported paste image mime/);
  });

  it("builds paste file names with sanitized timestamps", () => {
    const now = new Date("2026-09-11T10:59:59.123Z");
    expect(pasteImageName("image/png", now)).toBe("cw-paste-2026-09-11T10-59-59-123Z.png");
    expect(pasteImageName("image/jpeg", now)).toMatch(/^cw-paste-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jpg$/);
  });

  it("writes paste bytes and returns a posix relative path", () => {
    const svc = new FileService();
    const root = mkdtempSync(join(tmpdir(), "cw-paste-"));
    const data = Uint8Array.from([1, 2, 3, 4]);
    const rel = svc.savePasteImage(root, "image/png", data);
    expect(rel).toMatch(/^\.cw\/pastes\/cw-paste-[\dT-]+Z\.png$/);
    const written = readFileSync(join(root, rel.replaceAll("/", "\\")));
    expect(Array.from(written)).toEqual(Array.from(data));
  });
});
