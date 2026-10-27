import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTALL_ID_FILE = "install-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readInstallId(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return UUID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function readOrCreateInstallId(userDataDir: string, createId: () => string = randomUUID): string {
  const path = join(userDataDir, INSTALL_ID_FILE);
  const existing = readInstallId(path);
  if (existing) return existing;
  const id = createId();
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path, `${id}\n`, "utf8");
  return id;
}
