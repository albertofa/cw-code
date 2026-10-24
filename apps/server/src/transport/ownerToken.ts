import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicFile.js";

const TOKEN_FILE = "server-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

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

export function loadOrCreateOwnerToken(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, TOKEN_FILE);
  const existing = readToken(path);
  if (isValid(existing)) return existing;

  const token = newToken();
  if (existing !== null) {
    console.warn(`owner token at ${path} is invalid; generating a new one`);
    writeFileAtomic(path, token);
    return token;
  }
  try {
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readToken(path);
    if (isValid(raced)) return raced;
    writeFileAtomic(path, token);
    return token;
  }
}
