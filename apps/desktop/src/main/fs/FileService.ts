import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

export class FileService {
  readFile(root: string, target: string): string {
    const abs = assertInside(root, target);
    return readFileSync(abs, "utf8");
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
}

export { assertInside };
