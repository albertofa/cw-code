import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadElectronBuilderBlockMap } from "./blockMapBuilder.ts";

const DESKTOP_PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/desktop/package.json");

describe("loadElectronBuilderBlockMap", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-blockmap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the desktop app's electron-builder to write a gzip blockmap and report the file digest", async () => {
    const blockMap = loadElectronBuilderBlockMap(DESKTOP_PACKAGE_JSON);
    const desktop = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, "utf8")) as { devDependencies: Record<string, string> };
    expect(blockMap.electronBuilderVersion).toBe(desktop.devDependencies["electron-builder"]);

    const bytes = randomBytes(200_000);
    const input = join(dir, "installer.exe");
    await writeFile(input, bytes);
    const result = await blockMap.build(input, `${input}.blockmap`);

    expect(result).toEqual({ sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length });
    const decoded = JSON.parse(gunzipSync(await readFile(`${input}.blockmap`)).toString("utf8")) as {
      version: string;
      files: Array<{ sizes: number[] }>;
    };
    expect(decoded.version).toBe("2");
    expect(decoded.files[0].sizes.reduce((sum, size) => sum + size, 0)).toBe(bytes.length);
  });
});
