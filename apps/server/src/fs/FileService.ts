import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { DirEntry, FileReadResult, FileStatInfo } from "@cw-code/contracts";
import { attachmentsDir } from "../paths/appPaths.js";

const UNC_OR_DEVICE_PREFIX = /^[\\/]{2}/;

function isOutsideRoot(root: string, abs: string): boolean {
  const rel = relative(resolve(root), abs);
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}

function assertInside(root: string, target: string): string {
  if (UNC_OR_DEVICE_PREFIX.test(target)) throw new Error(`path escapes project root: ${target}`);
  const abs = resolve(resolve(root), target.replace(/\\/g, "/"));
  if (isOutsideRoot(root, abs)) throw new Error(`path escapes project root: ${target}`);
  return abs;
}

function resolveFileTarget(root: string, target: string): string {
  if (UNC_OR_DEVICE_PREFIX.test(target) || !isAbsolute(target)) return assertInside(root, target);
  return resolve(target);
}

const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const OUTSIDE_PREVIEW_EXTS = new Set([".md", ".markdown", ".html", ".htm"]);

function assertOutsidePreviewable(path: string, requested: string): void {
  if (UNC_OR_DEVICE_PREFIX.test(path)) throw new Error(`network and device paths cannot be previewed: ${requested}`);
  if (!isAbsolute(path)) throw new Error(`absolute path required: ${requested}`);
  if (!OUTSIDE_PREVIEW_EXTS.has(extname(path).toLowerCase())) throw new Error(`not a previewable file: ${requested}`);
}

const PASTE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export function imageExtMime(ext: string): string | null {
  return IMAGE_MIME_BY_EXT[ext.toLowerCase()] ?? null;
}

export function pasteImageExt(mime: string): string {
  const ext = PASTE_EXTS[mime];
  if (!ext) throw new Error("unsupported paste image mime: " + mime);
  return ext;
}

export function pasteImageName(mime: string, now: Date = new Date()): string {
  return `cw-paste-${now.toISOString().replaceAll(":", "-").replace(".", "-")}.${pasteImageExt(mime)}`;
}

export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;

export const TEXT_VIEW_MAX_BYTES = 20 * 1024 * 1024;

const BINARY_SNIFF_BYTES = 8000;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await lstat(abs);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function statOrNull(abs: string): Promise<Stats | null> {
  try {
    return await stat(abs);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function isSameEntry(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
  return first.ino !== 0n && first.dev === second.dev && first.ino === second.ino;
}

const BOM = "\uFEFF";

const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

async function startsWithUtf8Bom(abs: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(abs, "r");
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const head = Buffer.alloc(UTF8_BOM_BYTES.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(UTF8_BOM_BYTES);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(buffer: Uint8Array): { text: string; valid: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), valid: true };
  } catch {
    return { text: new TextDecoder("utf-8").decode(buffer), valid: false };
  }
}

function toStatInfo(stats: Stats): FileStatInfo {
  return { mtimeMs: stats.mtimeMs, size: stats.size };
}

export const LIST_DIR_MAX_ENTRIES = 2000;

const LIST_DIR_SKIP = new Set(["node_modules", ".git"]);

export class FileService {
  readFile(root: string, target: string): string {
    const abs = assertInside(root, target);
    return readFileSync(abs, "utf8");
  }

  readImage(root: string, target: string): { mime: string; base64: string } {
    const abs = resolveFileTarget(root, target);
    const ext = abs.split(".").pop() ?? "";
    const mime = imageExtMime(ext);
    if (!mime) throw new Error(`not an image: ${target}`);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error(`not a file: ${target}`);
    if (stat.size > IMAGE_MAX_BYTES) throw new Error(`image too large to preview: ${target}`);
    return { mime, base64: readFileSync(abs).toString("base64") };
  }

  readOutsideFile(target: string): string {
    assertOutsidePreviewable(target, target);
    let abs: string;
    try {
      abs = realpathSync(resolve(target));
    } catch {
      throw new Error(`file not found: ${target}`);
    }
    assertOutsidePreviewable(abs, target);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error(`not a file: ${target}`);
    if (stat.size > PREVIEW_MAX_BYTES) throw new Error(`file too large to preview: ${target}`);
    return readFileSync(abs, "utf8");
  }

  savePasteImage(root: string, mime: string, data: Uint8Array): string {
    void root;
    const dir = attachmentsDir();
    mkdirSync(dir, { recursive: true });
    const name = pasteImageName(mime);
    const abs = normalize(join(dir, name));
    writeFileSync(abs, data);
    return abs;
  }

  listFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (out.length < 5000) walk(join(dir, entry.name), rel);
        } else {
          out.push(rel);
          if (out.length >= 5000) return;
        }
      }
    };
    if (existsSync(root) && statSync(root).isDirectory()) walk(root, "");
    return out;
  }

  async listDir(root: string, dirRel = "", limit = LIST_DIR_MAX_ENTRIES): Promise<DirEntry[]> {
    const cleaned = dirRel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const rel = cleaned === "." ? "" : cleaned;
    const abs = rel ? assertInside(root, rel) : resolve(root);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(abs);
    } catch {
      throw new Error(`directory not found: ${rel || "."}`);
    }
    if (!dirStat.isDirectory()) throw new Error(`not a directory: ${rel || "."}`);
    const dirents = await readdir(abs, { withFileTypes: true });
    const cap = Math.max(1, Math.floor(limit));
    const out: DirEntry[] = [];
    for (const entry of dirents) {
      if (LIST_DIR_SKIP.has(entry.name)) continue;
      out.push({ name: entry.name, path: rel ? `${rel}/${entry.name}` : entry.name, isDir: entry.isDirectory() });
      if (out.length >= cap) break;
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return out;
  }

  async readFileInfo(root: string, target: string): Promise<FileReadResult> {
    const abs = resolveFileTarget(root, target);
    const stats = await statOrNull(abs);
    if (!stats?.isFile()) return { kind: "missing" };
    const { mtimeMs, size } = stats;
    if (size > TEXT_VIEW_MAX_BYTES) return { kind: "tooLarge", mtimeMs, size };
    const buffer = await readFile(abs);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary", mtimeMs, size };
    const { text: content, valid } = decodeUtf8(buffer);
    if (!valid) return { kind: "text", content, mtimeMs, size, readOnly: true, readOnlyReason: "encoding" };
    if (size > TEXT_EDIT_MAX_BYTES) return { kind: "text", content, mtimeMs, size, readOnly: true, readOnlyReason: "large" };
    return { kind: "text", content, mtimeMs, size, readOnly: false };
  }

  async writeFileGuarded(root: string, target: string, content: string, expectedMtimeMs?: number): Promise<FileStatInfo> {
    const abs = resolveFileTarget(root, target);
    const existing = await statOrNull(abs);
    if (!existing?.isFile() && isOutsideRoot(root, abs)) throw new Error(`file not found: ${target}`);
    if (expectedMtimeMs !== undefined) {
      if (existing && Math.floor(existing.mtimeMs) !== Math.floor(expectedMtimeMs)) {
        throw new Error(`file changed on disk: ${target}`);
      }
    }
    const keepBom = !content.startsWith(BOM) && (await startsWithUtf8Bom(abs));
    await writeFile(abs, keepBom ? BOM + content : content, "utf8");
    return toStatInfo(await stat(abs));
  }

  async createFile(root: string, target: string): Promise<void> {
    const abs = assertInside(root, target);
    if (await lstatOrNull(abs)) throw new Error(`already exists: ${target}`);
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(abs, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`already exists: ${target}`);
      throw error;
    }
  }

  async createDir(root: string, target: string): Promise<void> {
    const abs = assertInside(root, target);
    const existing = await lstatOrNull(abs);
    if (existing && !existing.isDirectory()) throw new Error(`already exists: ${target}`);
    await mkdir(abs, { recursive: true });
  }

  async renamePath(root: string, from: string, to: string): Promise<void> {
    const absFrom = this.resolveEntry(root, from);
    const absTo = this.resolveEntry(root, to);
    if (!(await lstatOrNull(absFrom))) throw new Error(`file not found: ${from}`);
    if (await lstatOrNull(absTo)) {
      const sameEntry = from.toLowerCase() === to.toLowerCase() && (await isSameEntry(absFrom, absTo));
      if (!sameEntry) throw new Error(`already exists: ${to}`);
    }
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
  }

  resolveEntry(root: string, target: string): string {
    const abs = assertInside(root, target);
    if (relative(resolve(root), abs) === "") throw new Error("cannot modify the workspace root");
    return abs;
  }
}

export { assertInside, isOutsideRoot, resolveFileTarget };
