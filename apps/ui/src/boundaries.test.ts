import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const SELF = fileURLToPath(import.meta.url);
const SRC_DIR = dirname(SELF);
const UI_ROOT = resolve(SRC_DIR, "..");
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const FORBIDDEN_PACKAGES = ["electron", ["@cw-code", "server"].join("/")];

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => SOURCE_FILE.test(file))
    .map((file) => join(SRC_DIR, file))
    .filter((file) => file !== SELF);
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function leavesUiPackage(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const fromRoot = relative(UI_ROOT, resolve(dirname(file), specifier));
  return fromRoot.startsWith("..") || isAbsolute(fromRoot);
}

function forbiddenImport(file: string, specifier: string): boolean {
  if (FORBIDDEN_PACKAGES.some((name) => isPackage(specifier, name))) return true;
  if (leavesUiPackage(file, specifier)) return true;
  return !TEST_FILE.test(file) && specifier.startsWith("node:");
}

function violations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      if (forbiddenImport(file, match[1])) found.push(`${relative(SRC_DIR, file).replace(/\\/g, "/")}: ${match[1]}`);
    }
  }
  return found;
}

describe("UI import boundaries", () => {
  it("scans the UI sources", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it("never imports Electron, the server, Node built-ins or files outside apps/ui", () => {
    expect(violations()).toEqual([]);
  });
});
