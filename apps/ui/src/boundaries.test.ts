import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => SOURCE_FILE.test(file))
    .map((file) => join(SRC_DIR, file));
}

function forbiddenImport(specifier: string, isTest: boolean): boolean {
  if (specifier === "electron" || specifier.startsWith("electron/")) return true;
  if (specifier === "@cw-code/server" || specifier.startsWith("@cw-code/server/")) return true;
  return !isTest && specifier.startsWith("node:");
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    const isTest = TEST_FILE.test(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      if (forbiddenImport(match[1], isTest)) found.push(`${relative(SRC_DIR, file).replace(/\\/g, "/")}: ${match[1]}`);
    }
  }
  return found;
}

describe("UI import boundaries", () => {
  it("scans the UI sources", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it("never imports Electron, the server or Node built-ins", () => {
    expect(violations()).toEqual([]);
  });
});
