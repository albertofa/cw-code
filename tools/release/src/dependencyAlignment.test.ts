import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

describe("dependency alignment with the shipped updater", () => {
  it("pins builder-util-runtime to the exact version electron-updater in apps/desktop depends on", () => {
    const tools = readManifest(resolve(REPO_ROOT, "tools/release/package.json"));
    const fromDesktop = createRequire(resolve(REPO_ROOT, "apps/desktop/package.json"));
    const updater = readManifest(fromDesktop.resolve("electron-updater/package.json"));
    const expected = updater.dependencies?.["builder-util-runtime"];
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tools.dependencies?.["builder-util-runtime"]).toBe(expected);
    const fromTools = createRequire(resolve(REPO_ROOT, "tools/release/package.json"));
    expect(readManifest(fromTools.resolve("builder-util-runtime/package.json")).version).toBe(expected);
  });
});
