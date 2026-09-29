import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { FileService, assertInside, imageExtMime, pasteImageExt, pasteImageName } from "./FileService.js";
import { attachmentsDir } from "../paths/appPaths.js";

describe("FileService sandbox", () => {
  const svc = new FileService();
  const root = join(tmpdir(), "cw-code-probe");

  it("rejects paths escaping the project root", () => {
    expect(() => svc.readFile(root, "../outside.txt")).toThrow(/escapes project root/);
    expect(() => svc.saveFile(root, "..\\outside.txt", "x")).toThrow(/escapes project root/);
  });

  it.runIf(process.platform === "win32")("rejects paths on another drive", () => {
    const other = root.toUpperCase().startsWith("Z:") ? "Y:" : "Z:";
    expect(() => assertInside(root, `${other}/x/a.md`)).toThrow(/escapes project root/);
    expect(() => assertInside(root, `${other}\\x\\a.md`)).toThrow(/escapes project root/);
    expect(() => assertInside(root, `${other}a.md`)).toThrow(/escapes project root/);
    expect(() => svc.readFile(root, `${other}/x/a.md`)).toThrow(/escapes project root/);
  });

  it("rejects UNC paths in both slash styles", () => {
    expect(() => assertInside(root, "//evil/share/a.txt")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "\\\\evil\\share\\a.txt")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "\\/evil/share/a.txt")).toThrow(/escapes project root/);
    expect(() => svc.saveFile(root, "\\\\evil\\share\\a.txt", "x")).toThrow(/escapes project root/);
  });

  it("rejects device paths", () => {
    expect(() => assertInside(root, "\\\\?\\C:\\wt\\a.md")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "\\\\.\\C:\\wt\\a.md")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "//?/C:/wt/a.md")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "//./pipe/x")).toThrow(/escapes project root/);
  });

  it("rejects parent-directory escapes", () => {
    expect(() => assertInside(root, "..")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "a/../../b.md")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "a\\..\\..\\b.md")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "/outside/a.md")).toThrow(/escapes project root/);
  });

  it("accepts nested paths inside the root", () => {
    expect(assertInside(root, "src/a/b.md")).toBe(join(root, "src", "a", "b.md"));
    expect(assertInside(root, "src\\a\\b.md")).toBe(join(root, "src", "a", "b.md"));
    expect(assertInside(root, "src/../b.md")).toBe(join(root, "b.md"));
    expect(assertInside(root, "..name.md")).toBe(join(root, "..name.md"));
    expect(assertInside(root, join(root, "src", "a.md"))).toBe(join(root, "src", "a.md"));
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
    mkdirSync(join(dir, "folder.md"));
    expect(() => svc.readOutsideFile(join(dir, "folder.md"))).toThrow(/not a file/);
    expect(() => svc.readOutsideFile("relative.md")).toThrow(/absolute path required/);
  });

  it("restricts outside reads to preview extensions case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-outside-ext-"));
    for (const name of ["a.MD", "b.Markdown", "c.HTML", "d.htm"]) {
      writeFileSync(join(dir, name), name, "utf8");
      expect(svc.readOutsideFile(join(dir, name))).toBe(name);
    }
    for (const name of ["secret.txt", "config.json", "id_rsa", ".env", "run.ps1"]) {
      writeFileSync(join(dir, name), "x", "utf8");
      expect(() => svc.readOutsideFile(join(dir, name))).toThrow(/not a previewable file/);
    }
    expect(() => svc.readOutsideFile(dir)).toThrow(/not a previewable file/);
  });

  it("checks the extension of the file a symlinked preview path points at", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-outside-link-"));
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "linked.md"), "junction");
    expect(() => svc.readOutsideFile(join(dir, "linked.md"))).toThrow(/not a previewable file/);
    writeFileSync(join(dir, "secret.txt"), "secret", "utf8");
    writeFileSync(join(dir, "real.md"), "# real", "utf8");
    try {
      symlinkSync(join(dir, "secret.txt"), join(dir, "bait.md"), "file");
      symlinkSync(join(dir, "real.md"), join(dir, "alias.md"), "file");
    } catch {
      return;
    }
    expect(() => svc.readOutsideFile(join(dir, "bait.md"))).toThrow(/not a previewable file/);
    expect(svc.readOutsideFile(join(dir, "alias.md"))).toBe("# real");
  });

  it("rejects UNC and device paths for outside reads", () => {
    expect(() => svc.readOutsideFile("\\\\server\\share\\a.md")).toThrow(/network and device paths/);
    expect(() => svc.readOutsideFile("//server/share/a.md")).toThrow(/network and device paths/);
    expect(() => svc.readOutsideFile("\\\\?\\C:\\a.md")).toThrow(/network and device paths/);
    expect(() => svc.readOutsideFile("\\\\.\\C:\\a.md")).toThrow(/network and device paths/);
  });
});

describe("FileService listDir", () => {
  function seedTree(): string {
    const root = mkdtempSync(join(tmpdir(), "cw-listdir-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "b.txt"), "b", "utf8");
    writeFileSync(join(root, "a.txt"), "a", "utf8");
    writeFileSync(join(root, "src", "index.ts"), "x", "utf8");
    writeFileSync(join(root, "node_modules", "dep.js"), "x", "utf8");
    return root;
  }

  it("lists a single level with directories first and skips managed dirs", async () => {
    const svc = new FileService();
    const entries = await svc.listDir(seedTree());
    expect(entries).toEqual([
      { name: "src", path: "src", isDir: true },
      { name: "a.txt", path: "a.txt", isDir: false },
      { name: "b.txt", path: "b.txt", isDir: false }
    ]);
  });

  it("lists nested dirs with posix relative paths", async () => {
    const svc = new FileService();
    const root = seedTree();
    expect(await svc.listDir(root, "src")).toEqual([
      { name: "index.ts", path: "src/index.ts", isDir: false }
    ]);
    expect(await svc.listDir(root, "src/")).toEqual([
      { name: "index.ts", path: "src/index.ts", isDir: false }
    ]);
  });

  it("rejects paths escaping the project root", async () => {
    const svc = new FileService();
    const root = seedTree();
    await expect(svc.listDir(root, "..")).rejects.toThrow(/escapes project root/);
    await expect(svc.listDir(root, "src/../../..")).rejects.toThrow(/escapes project root/);
    await expect(svc.listDir(root, "..\\outside")).rejects.toThrow(/escapes project root/);
  });

  it("throws for missing dirs and file targets", async () => {
    const svc = new FileService();
    const root = seedTree();
    await expect(svc.listDir(root, "missing")).rejects.toThrow(/directory not found/);
    await expect(svc.listDir(root, "a.txt")).rejects.toThrow(/not a directory/);
  });

  it("respects the entry limit", async () => {
    const svc = new FileService();
    const root = seedTree();
    const entries = await svc.listDir(root, "", 2);
    expect(entries).toHaveLength(2);
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

  it("maps image extensions back to mimes", () => {
    expect(imageExtMime("png")).toBe("image/png");
    expect(imageExtMime("JPEG")).toBe("image/jpeg");
    expect(imageExtMime("webp")).toBe("image/webp");
    expect(imageExtMime("gif")).toBe("image/gif");
    expect(imageExtMime("svg")).toBeNull();
  });

  it("reads images inside the root with mime and base64", () => {
    const svc = new FileService();
    const root = mkdtempSync(join(tmpdir(), "cw-readimg-"));
    writeFileSync(join(root, "pic.png"), Uint8Array.from([137, 80, 78, 71]));
    const img = svc.readImage(root, "pic.png");
    expect(img.mime).toBe("image/png");
    expect(img.base64).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
  });

  it("rejects non-image files, missing files, and escapes", () => {
    const svc = new FileService();
    const root = mkdtempSync(join(tmpdir(), "cw-readimg2-"));
    writeFileSync(join(root, "note.txt"), "x", "utf8");
    expect(() => svc.readImage(root, "note.txt")).toThrow(/not an image/);
    expect(() => svc.readImage(root, "missing.png")).toThrow();
    expect(() => svc.readImage(root, "../x.png")).toThrow(/escapes project root/);
  });

  it("builds paste file names with sanitized timestamps", () => {
    const now = new Date("2026-09-11T10:59:59.123Z");
    expect(pasteImageName("image/png", now)).toBe("cw-paste-2026-09-11T10-59-59-123Z.png");
    expect(pasteImageName("image/jpeg", now)).toMatch(/^cw-paste-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jpg$/);
  });

  it("writes paste bytes to the central attachments dir and returns an absolute path", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-home-"));
    const previous = process.env["CW_CODE_HOME"];
    process.env["CW_CODE_HOME"] = home;
    try {
      const svc = new FileService();
      const root = mkdtempSync(join(tmpdir(), "cw-paste-"));
      const data = Uint8Array.from([1, 2, 3, 4]);
      const abs = svc.savePasteImage(root, "image/png", data);
      expect(isAbsolute(abs)).toBe(true);
      expect(normalize(abs).startsWith(normalize(attachmentsDir()))).toBe(true);
      expect(abs).toMatch(/cw-paste-[\dT-]+Z\.png$/);
      expect(Array.from(readFileSync(abs))).toEqual(Array.from(data));
    } finally {
      if (previous === undefined) delete process.env["CW_CODE_HOME"];
      else process.env["CW_CODE_HOME"] = previous;
    }
  });
});
