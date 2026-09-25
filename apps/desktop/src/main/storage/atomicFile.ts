import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 50;
const RENAME_BACKOFF_MAX_MS = 250;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      sleepSync(Math.min(RENAME_BACKOFF_MAX_MS, RENAME_BACKOFF_MS * attempt));
    }
  }
}

function writeAndSync(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx");
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeTemp(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.warn(`could not remove temp file ${path}: ${(error as Error).message}`);
  }
}

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeAndSync(tmp, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    renameWithRetry(tmp, path);
  } catch (error) {
    removeTemp(tmp);
    throw error;
  }
}

export function readBytesIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
