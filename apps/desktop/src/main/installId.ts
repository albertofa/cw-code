import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_ID_FILE = "install-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStored(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function validId(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value : null;
}

function writeId(path: string, id: string, exclusive: boolean): boolean {
  try {
    writeFileSync(path, `${id}\n`, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function readOrCreateInstallId(userDataDir: string, createId: () => string = randomUUID): string {
  const path = join(userDataDir, INSTALL_ID_FILE);
  const stored = readStored(path);
  const existing = validId(stored);
  if (existing) return existing;
  const id = createId();
  mkdirSync(userDataDir, { recursive: true });
  if (writeId(path, id, stored === null)) return id;
  const winner = validId(readStored(path));
  if (winner) return winner;
  writeId(path, id, false);
  return id;
}
