import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVersion, checkSync, readPackageVersions, setBase } from "./packageVersions.ts";

const FILE_NAMES = ["root.json", "desktop.json", "contracts.json"];

describe("packageVersions", () => {
  let dir: string;
  let paths: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-release-tools-"));
    paths = FILE_NAMES.map((name) => join(dir, name));
    for (const path of paths) {
      await writeFile(path, `${JSON.stringify({ name: "pkg", version: "0.0.1-alpha.21" }, null, 2)}\n`, "utf8");
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads versions from every file", async () => {
    const entries = await readPackageVersions(paths);
    expect(entries.map((entry) => entry.version)).toEqual(["0.0.1-alpha.21", "0.0.1-alpha.21", "0.0.1-alpha.21"]);
  });

  it("reports in-sync when all versions match", async () => {
    const result = await checkSync(paths);
    expect(result.inSync).toBe(true);
    expect(result.version).toBe("0.0.1-alpha.21");
  });

  it("reports out-of-sync when versions differ", async () => {
    await writeFile(paths[1], `${JSON.stringify({ name: "pkg", version: "0.0.1-alpha.22" }, null, 2)}\n`, "utf8");
    const result = await checkSync(paths);
    expect(result.inSync).toBe(false);
    expect(result.version).toBeNull();
  });

  it("applies a new version to every file and preserves other fields", async () => {
    await applyVersion(paths, "0.0.1-alpha.22");
    for (const path of paths) {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { name: string; version: string };
      expect(parsed.version).toBe("0.0.1-alpha.22");
      expect(parsed.name).toBe("pkg");
    }
  });

  it("rejects applying a malformed version", async () => {
    await expect(applyVersion(paths, "not-a-version")).rejects.toThrow();
  });

  it("writes a stable base version via set-base", async () => {
    await setBase(paths, "0.0.2");
    const result = await checkSync(paths);
    expect(result.version).toBe("0.0.2");
  });

  it("rejects set-base with a prerelease version", async () => {
    await expect(setBase(paths, "0.0.2-alpha.0")).rejects.toThrow();
  });
});
