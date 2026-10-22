import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import {
  FileService,
  TEXT_EDIT_MAX_BYTES,
  TEXT_VIEW_MAX_BYTES,
  assertInside,
  imageExtMime,
  pasteImageExt,
  pasteImageName
} from "./FileService.js";
import { attachmentsDir } from "../paths/appPaths.js";

async function readText(root: string, path: string) {
  const info = await new FileService().readFileInfo(root, path);
  if (info.kind !== "text") throw new Error(`expected a text file, got ${info.kind}`);
  return info;
}

describe("FileService sandbox", () => {
  const svc = new FileService();
  const root = join(tmpdir(), "cw-code-probe");

  it("rejects paths escaping the project root", async () => {
    expect(() => svc.readFile(root, "../outside.txt")).toThrow(/escapes project root/);
    await expect(svc.writeFileGuarded(root, "..\\outside.txt", "x")).rejects.toThrow(/escapes project root/);
  });

  it.runIf(process.platform === "win32")("rejects paths on another drive", () => {
    const other = root.toUpperCase().startsWith("Z:") ? "Y:" : "Z:";
    expect(() => assertInside(root, `${other}/x/a.md`)).toThrow(/escapes project root/);
    expect(() => assertInside(root, `${other}\\x\\a.md`)).toThrow(/escapes project root/);
    expect(() => assertInside(root, `${other}a.md`)).toThrow(/escapes project root/);
    expect(() => svc.readFile(root, `${other}/x/a.md`)).toThrow(/escapes project root/);
  });

  it("rejects UNC paths in both slash styles", async () => {
    expect(() => assertInside(root, "//evil/share/a.txt")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "\\\\evil\\share\\a.txt")).toThrow(/escapes project root/);
    expect(() => assertInside(root, "\\/evil/share/a.txt")).toThrow(/escapes project root/);
    await expect(svc.writeFileGuarded(root, "\\\\evil\\share\\a.txt", "x")).rejects.toThrow(/escapes project root/);
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

describe("FileService file operations", () => {
  const svc = new FileService();

  function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "cw-fileops-"));
  }

  describe("absolute paths outside the workspace", () => {
    it("reads and writes an absolute file outside the root", async () => {
      const root = makeRoot();
      const file = join(makeRoot(), "migration.sql");
      writeFileSync(file, "select 1;", "utf8");
      const info = await readText(root, file);
      expect(info).toMatchObject({ content: "select 1;", readOnly: false });
      await svc.writeFileGuarded(root, file.replace(/\\/g, "/"), "select 2;", info.mtimeMs);
      expect(readFileSync(file, "utf8")).toBe("select 2;");
    });

    it("never creates a file outside the root", async () => {
      const file = join(makeRoot(), "new.ts");
      await expect(svc.writeFileGuarded(makeRoot(), file, "x")).rejects.toThrow(/file not found/);
      await expect(svc.writeFileGuarded(makeRoot(), file, "x", 1)).rejects.toThrow(/file not found/);
      expect(() => statSync(file)).toThrow();
    });

    it("reports a missing absolute file as missing", async () => {
      expect(await svc.readFileInfo(makeRoot(), join(makeRoot(), "gone.ts"))).toEqual({ kind: "missing" });
    });

    it("still rejects relative escapes and network paths", async () => {
      const root = makeRoot();
      await expect(svc.readFileInfo(root, "../x.ts")).rejects.toThrow(/escapes project root/);
      await expect(svc.readFileInfo(root, "//server/share/x.ts")).rejects.toThrow(/escapes project root/);
      await expect(svc.writeFileGuarded(root, "\\\\?\\C:\\x.ts", "x")).rejects.toThrow(/escapes project root/);
    });
  });

  describe("readFileInfo", () => {
    it("reads text with size and mtime", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "hello", "utf8");
      const info = await readText(root, "a.txt");
      expect(info).toMatchObject({ kind: "text", content: "hello", size: 5, readOnly: false });
      expect(info.mtimeMs).toBeGreaterThan(0);
    });

    it("strips a leading BOM", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
      const info = await svc.readFileInfo(root, "bom.txt");
      expect(info).toMatchObject({ kind: "text", content: "hi" });
    });

    it("flags binary files by a NUL in the first 8000 bytes", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
      expect((await svc.readFileInfo(root, "bin.dat")).kind).toBe("binary");
      writeFileSync(join(root, "late-nul.txt"), Buffer.concat([Buffer.alloc(8000, 97), Buffer.from([0])]));
      expect((await svc.readFileInfo(root, "late-nul.txt")).kind).toBe("text");
    });

    it("marks text above the edit limit as read-only", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "edge.txt"), Buffer.alloc(TEXT_EDIT_MAX_BYTES, 97));
      writeFileSync(join(root, "big.txt"), Buffer.alloc(TEXT_EDIT_MAX_BYTES + 1, 97));
      expect(await svc.readFileInfo(root, "edge.txt")).toMatchObject({ kind: "text", readOnly: false });
      expect(await svc.readFileInfo(root, "big.txt")).toMatchObject({
        kind: "text",
        readOnly: true,
        readOnlyReason: "large"
      });
      expect(await svc.readFileInfo(root, "edge.txt")).not.toHaveProperty("readOnlyReason");
    });

    it("returns non-UTF-8 text as read-only with the encoding reason", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      const info = await svc.readFileInfo(root, "latin1.txt");
      expect(info).toMatchObject({ kind: "text", readOnly: true, readOnlyReason: "encoding" });
      expect(info.kind === "text" && info.content.startsWith("caf")).toBe(true);
    });

    it("keeps valid multibyte UTF-8 editable", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "utf8.txt"), "café ✓", "utf8");
      expect(await svc.readFileInfo(root, "utf8.txt")).toMatchObject({
        kind: "text",
        content: "café ✓",
        readOnly: false
      });
    });

    it("only maps missing paths to a missing result and rethrows other stat errors", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "file.txt"), "x", "utf8");
      expect(await svc.readFileInfo(root, "file.txt/child")).toEqual({ kind: "missing" });
      const error = await svc.readFileInfo(root, "bad\0name").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/file not found/);
    });

    it("returns tooLarge above the view limit without reading content", async () => {
      const root = makeRoot();
      const file = join(root, "huge.bin");
      writeFileSync(file, "");
      truncateSync(file, TEXT_VIEW_MAX_BYTES + 1);
      expect(await svc.readFileInfo(root, "huge.bin")).toMatchObject({
        kind: "tooLarge",
        size: TEXT_VIEW_MAX_BYTES + 1
      });
    });

    it("reports missing paths and directories as missing", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "dir"));
      expect(await svc.readFileInfo(root, "missing.txt")).toEqual({ kind: "missing" });
      expect(await svc.readFileInfo(root, "dir")).toEqual({ kind: "missing" });
    });
  });

  describe("writeFileGuarded", () => {
    it("writes when the expected mtime matches and returns the new stat", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "old", "utf8");
      const before = await readText(root, "a.txt");
      const stat = await svc.writeFileGuarded(root, "a.txt", "new!", before.mtimeMs);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new!");
      expect(stat.size).toBe(4);
    });

    it("compares mtimes by floored milliseconds", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "old", "utf8");
      const { mtimeMs } = await readText(root, "a.txt");
      await expect(svc.writeFileGuarded(root, "a.txt", "x", Math.floor(mtimeMs) + 0.4)).resolves.toBeDefined();
    });

    it("rejects when the file changed on disk and leaves it untouched", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "old", "utf8");
      const { mtimeMs } = await readText(root, "a.txt");
      await expect(svc.writeFileGuarded(root, "a.txt", "new", mtimeMs - 5000)).rejects.toThrow(
        "file changed on disk: a.txt"
      );
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old");
    });

    it("creates the file when it does not exist, with or without an expected mtime", async () => {
      const root = makeRoot();
      await svc.writeFileGuarded(root, "fresh.txt", "one", 123);
      expect(readFileSync(join(root, "fresh.txt"), "utf8")).toBe("one");
      await svc.writeFileGuarded(root, "fresh2.txt", "two");
      expect(readFileSync(join(root, "fresh2.txt"), "utf8")).toBe("two");
    });

    it("keeps the BOM of an existing file across a read and write round-trip", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "bom.cs"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old")]));
      const info = await readText(root, "bom.cs");
      expect(info).toMatchObject({ kind: "text", content: "old" });
      await svc.writeFileGuarded(root, "bom.cs", "new", info.mtimeMs);
      expect(Array.from(readFileSync(join(root, "bom.cs")))).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("new")]);
    });

    it("does not double the BOM when the content already starts with one", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "bom.cs"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old")]));
      await svc.writeFileGuarded(root, "bom.cs", "\uFEFFnew");
      expect(Array.from(readFileSync(join(root, "bom.cs")))).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("new")]);
    });

    it("keeps a BOM-less file BOM-less and creates new files without a BOM", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "plain.cs"), "old", "utf8");
      await svc.writeFileGuarded(root, "plain.cs", "new");
      expect(Array.from(readFileSync(join(root, "plain.cs")))).toEqual(Array.from(Buffer.from("new")));
      await svc.writeFileGuarded(root, "fresh.cs", "new");
      expect(Array.from(readFileSync(join(root, "fresh.cs")))).toEqual(Array.from(Buffer.from("new")));
    });

    it("handles files shorter than the BOM", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "tiny.txt"), "a", "utf8");
      writeFileSync(join(root, "empty.txt"), "", "utf8");
      await svc.writeFileGuarded(root, "tiny.txt", "bb");
      await svc.writeFileGuarded(root, "empty.txt", "cc");
      expect(readFileSync(join(root, "tiny.txt"), "utf8")).toBe("bb");
      expect(readFileSync(join(root, "empty.txt"), "utf8")).toBe("cc");
    });

    it("guards symlinks by the mtime of their target", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "real.txt"), "old", "utf8");
      try {
        symlinkSync(join(root, "real.txt"), join(root, "link.txt"), "file");
      } catch {
        return;
      }
      const info = await readText(root, "link.txt");
      await svc.writeFileGuarded(root, "link.txt", "new", info.mtimeMs);
      expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("new");
    });

    it("writes unguarded when no expected mtime is given", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "old", "utf8");
      await svc.writeFileGuarded(root, "a.txt", "new");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
    });
  });

  describe("createFile", () => {
    it("creates an empty file and missing parent dirs", async () => {
      const root = makeRoot();
      await svc.createFile(root, "a/b/c.txt");
      expect(readFileSync(join(root, "a", "b", "c.txt"), "utf8")).toBe("");
    });

    it("rejects when a file or directory already exists", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "keep", "utf8");
      mkdirSync(join(root, "dir"));
      await expect(svc.createFile(root, "a.txt")).rejects.toThrow("already exists: a.txt");
      await expect(svc.createFile(root, "dir")).rejects.toThrow("already exists: dir");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("keep");
    });
  });

  describe("createDir", () => {
    it("creates nested dirs and tolerates an existing dir", async () => {
      const root = makeRoot();
      await svc.createDir(root, "a/b");
      expect(statSync(join(root, "a", "b")).isDirectory()).toBe(true);
      await expect(svc.createDir(root, "a/b")).resolves.toBeUndefined();
    });

    it("rejects when a file exists at the path", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "x", "utf8");
      await expect(svc.createDir(root, "a.txt")).rejects.toThrow("already exists: a.txt");
    });
  });

  describe("renamePath", () => {
    it("renames files and directories, creating the target parent", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "a", "utf8");
      mkdirSync(join(root, "d"));
      writeFileSync(join(root, "d", "x.txt"), "x", "utf8");
      await svc.renamePath(root, "a.txt", "new/dir/b.txt");
      expect(readFileSync(join(root, "new", "dir", "b.txt"), "utf8")).toBe("a");
      await svc.renamePath(root, "d", "e");
      expect(readFileSync(join(root, "e", "x.txt"), "utf8")).toBe("x");
    });

    it("rejects when the target exists and leaves both untouched", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "a", "utf8");
      writeFileSync(join(root, "b.txt"), "b", "utf8");
      await expect(svc.renamePath(root, "a.txt", "b.txt")).rejects.toThrow("already exists: b.txt");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a");
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b");
    });

    it("allows a case-only rename of the same path", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "readme.md"), "r", "utf8");
      await svc.renamePath(root, "readme.md", "README.md");
      expect(readdirSync(root)).toEqual(["README.md"]);
    });

    it("rejects a case-only rename onto a different existing file", async () => {
      const root = makeRoot();
      writeFileSync(join(root, "a.txt"), "lower", "utf8");
      writeFileSync(join(root, "A.txt"), "upper", "utf8");
      if (readdirSync(root).length < 2) return;
      await expect(svc.renamePath(root, "a.txt", "A.txt")).rejects.toThrow("already exists: A.txt");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("lower");
      expect(readFileSync(join(root, "A.txt"), "utf8")).toBe("upper");
    });

    it("checks the source before creating the target parent", async () => {
      const root = makeRoot();
      await expect(svc.renamePath(root, "missing.txt", "new/dir/b.txt")).rejects.toThrow("file not found: missing.txt");
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses to rename the workspace root", async () => {
      const root = makeRoot();
      await expect(svc.renamePath(root, "", "x")).rejects.toThrow("cannot modify the workspace root");
      await expect(svc.renamePath(root, "x", ".")).rejects.toThrow("cannot modify the workspace root");
    });
  });

  describe("resolveEntry", () => {
    it("returns the absolute path inside the root", () => {
      const root = makeRoot();
      expect(svc.resolveEntry(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
    });

    it("throws for the workspace root in every spelling", () => {
      const root = makeRoot();
      for (const target of ["", ".", "./", "src/.."]) {
        expect(() => svc.resolveEntry(root, target)).toThrow("cannot modify the workspace root");
      }
    });
  });

  it.runIf(process.platform === "win32")("treats a differently cased spelling of the root as the root", () => {
    const root = makeRoot();
    expect(() => svc.resolveEntry(root, `../${basename(root).toUpperCase()}`)).toThrow(
      "cannot modify the workspace root"
    );
  });

  describe("sandboxing", () => {
    const escapes = ["../x", "..\\x", "a/../../x", "//server/x", "\\\\server\\x", "/outside/x"];

    it("rejects escaping paths in every operation", async () => {
      const root = makeRoot();
      for (const target of escapes) {
        if (target !== "/outside/x") {
          await expect(svc.readFileInfo(root, target), target).rejects.toThrow(/escapes project root/);
          await expect(svc.writeFileGuarded(root, target, "x"), target).rejects.toThrow(/escapes project root/);
        }
        await expect(svc.createFile(root, target), target).rejects.toThrow(/escapes project root/);
        await expect(svc.createDir(root, target), target).rejects.toThrow(/escapes project root/);
        await expect(svc.renamePath(root, target, "ok.txt"), target).rejects.toThrow(/escapes project root/);
        await expect(svc.renamePath(root, "ok.txt", target), target).rejects.toThrow(/escapes project root/);
        expect(() => svc.resolveEntry(root, target), target).toThrow(/escapes project root/);
      }
    });

    it.runIf(process.platform === "win32")("rejects another drive on tree operations", async () => {
      const root = makeRoot();
      const other = root.toUpperCase().startsWith("Z:") ? "Y:" : "Z:";
      await expect(svc.readFileInfo(root, `${other}x`)).rejects.toThrow(/escapes project root/);
      await expect(svc.createFile(root, `${other}/x`)).rejects.toThrow(/escapes project root/);
    });
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
