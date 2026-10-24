import { SERVER_TOKEN_FILE } from "@cw-code/shared/protocol";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicFile.js";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_ONLY = 0o600;

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function readToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isValid(token: string | null): token is string {
  return token !== null && TOKEN_PATTERN.test(token);
}

function rewriteToken(path: string, token: string): string {
  writeFileAtomic(path, token);
  try {
    chmodSync(path, OWNER_ONLY);
  } catch (error) {
    if (process.platform !== "win32") console.warn(`could not restrict ${path} to its owner: ${(error as Error).message}`);
  }
  return token;
}

export function loadOrCreateOwnerToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SERVER_TOKEN_FILE);
  const existing = readToken(path);
  if (isValid(existing)) return existing;

  const token = newToken();
  if (existing !== null) {
    console.warn(`owner token at ${path} is invalid; generating a new one`);
    return rewriteToken(path, token);
  }
  try {
    writeFileSync(path, token, { mode: OWNER_ONLY, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readToken(path);
    if (isValid(raced)) return raced;
    return rewriteToken(path, token);
  }
}
