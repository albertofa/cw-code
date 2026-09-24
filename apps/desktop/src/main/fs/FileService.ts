import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { attachmentsDir } from "../paths/appPaths.js";

function assertInside(root: string, target: string): string {
  const abs = resolve(root, target.replace(/\\/g, "/"));
  const rel = relative(resolve(root), abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || abs !== resolve(abs)) {
    throw new Error(`path escapes project root: ${target}`);
  }
  void abs;
  return abs;
}

const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

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

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export const LIST_DIR_MAX_ENTRIES = 2000;

const LIST_DIR_SKIP = new Set(["node_modules", ".git"]);

export class FileService {
  readFile(root: string, target: string): string {
    const abs = assertInside(root, target);
    return readFileSync(abs, "utf8");
  }

  readImage(root: string, target: string): { mime: string; base64: string } {
    const abs = assertInside(root, target);
    const ext = abs.split(".").pop() ?? "";
    const mime = imageExtMime(ext);
    if (!mime) throw new Error(`not an image: ${target}`);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error(`not a file: ${target}`);
    if (stat.size > IMAGE_MAX_BYTES) throw new Error(`image too large to preview: ${target}`);
    return { mime, base64: readFileSync(abs).toString("base64") };
  }

  readOutsideFile(target: string): string {
    if (!isAbsolute(target)) throw new Error(`absolute path required: ${target}`);
    const abs = resolve(target);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      throw new Error(`file not found: ${target}`);
    }
    if (!stat.isFile()) throw new Error(`not a file: ${target}`);
    if (stat.size > PREVIEW_MAX_BYTES) throw new Error(`file too large to preview: ${target}`);
    return readFileSync(abs, "utf8");
  }

  saveFile(root: string, target: string, content: string): void {
    const abs = assertInside(root, target);
    writeFileSync(abs, content, "utf8");
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
}

export { assertInside };
