import { renameSync, rmSync, statSync } from "node:fs";
import { extname } from "node:path";

export function rotationPath(filePath: string): string {
  const ext = extname(filePath);
  return ext ? `${filePath.slice(0, -ext.length)}.1${ext}` : `${filePath}.1`;
}

export function rotateIfOversize(filePath: string, maxBytes: number): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  const dest = rotationPath(filePath);
  rmSync(dest, { force: true });
  renameSync(filePath, dest);
}
