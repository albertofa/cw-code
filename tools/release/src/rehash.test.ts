import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BlockMapBuilder, readReleaseUpdateInfo, rehashRelease } from "./rehash.ts";
import { parseUpdateInfo } from "./updateInfoYaml.ts";

const INSTALLER = "cw-code-Setup-1.2.0-alpha.3-x64.exe";

function updateInfo(sha512: string, size: number, installer = INSTALLER): string {
  return [
    "version: 1.2.0-alpha.3",
    "files:",
    `  - url: ${installer}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installer}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-09-25T00:56:11.610Z'",
    ""
  ].join("\n");
}

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

const fakeBuilder: BlockMapBuilder = async (installerPath, blockMapPath) => {
  const bytes = await readFile(installerPath);
  await writeFile(blockMapPath, "fake-blockmap");
  return { sha512: digest(bytes), size: bytes.length };
};

describe("rehashRelease", () => {
  let dir: string;
  let unsigned: Buffer;
  let signed: Buffer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-rehash-"));
    unsigned = randomBytes(2048);
    signed = Buffer.concat([unsigned, randomBytes(512)]);
    await writeFile(join(dir, INSTALLER), signed);
    await writeFile(join(dir, `${INSTALLER}.blockmap`), "stale");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites both channel files and regenerates the blockmap after signing changed the installer", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length));
    await writeFile(join(dir, "alpha.yml"), updateInfo(digest(unsigned), unsigned.length));

    const result = await rehashRelease(dir, fakeBuilder);

    expect(result).toMatchObject({ installer: INSTALLER, blockMap: `${INSTALLER}.blockmap`, sha512: digest(signed), size: signed.length });
    expect(result.manifests.map((manifest) => [manifest.file, manifest.changed])).toEqual([
      ["latest.yml", true],
      ["alpha.yml", true]
    ]);
    expect(result.manifests[0].previous).toEqual({ sha512: digest(unsigned), size: unsigned.length });
    for (const name of ["latest.yml", "alpha.yml"]) {
      const info = parseUpdateInfo(await readFile(join(dir, name), "utf8"));
      expect(info.sha512).toBe(digest(signed));
      expect(info.files[0]).toEqual({ url: INSTALLER, sha512: digest(signed), size: signed.length });
    }
    expect(await readFile(join(dir, `${INSTALLER}.blockmap`), "utf8")).toBe("fake-blockmap");
    expect((await readReleaseUpdateInfo(dir)).sha512).toBe(digest(signed));
  });

  it("works with only latest.yml and is idempotent", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length));
    await rehashRelease(dir, fakeBuilder);
    const before = await readFile(join(dir, "latest.yml"), "utf8");
    const again = await rehashRelease(dir, fakeBuilder);
    expect(again.manifests).toEqual([{ file: "latest.yml", changed: false, previous: { sha512: digest(signed), size: signed.length } }]);
    expect(await readFile(join(dir, "latest.yml"), "utf8")).toBe(before);
  });

  it("fails when no update info file exists", async () => {
    await expect(rehashRelease(dir, fakeBuilder)).rejects.toThrow(/No update info file/);
  });

  it("fails when the referenced installer is missing", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length, "missing.exe"));
    await expect(rehashRelease(dir, fakeBuilder)).rejects.toThrow(/"missing.exe" .* does not exist/);
  });

  it("fails when channel files reference different installers", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length));
    await writeFile(join(dir, "alpha.yml"), updateInfo(digest(unsigned), unsigned.length, "other.exe"));
    await expect(rehashRelease(dir, fakeBuilder)).rejects.toThrow(/different installers/);
  });

  it("fails when the blockmap builder reports a digest that does not match the file", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length));
    const lying: BlockMapBuilder = async (_installer, blockMapPath) => {
      await writeFile(blockMapPath, "x");
      return { sha512: digest(unsigned), size: unsigned.length };
    };
    await expect(rehashRelease(dir, lying)).rejects.toThrow(/do not match/);
    expect(parseUpdateInfo(await readFile(join(dir, "latest.yml"), "utf8")).sha512).toBe(digest(unsigned));
  });

  it("fails when the blockmap builder does not write the blockmap", async () => {
    await rm(join(dir, `${INSTALLER}.blockmap`));
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(unsigned), unsigned.length));
    const silent: BlockMapBuilder = async (installerPath) => {
      const bytes = await readFile(installerPath);
      return { sha512: digest(bytes), size: (await stat(installerPath)).size };
    };
    await expect(rehashRelease(dir, silent)).rejects.toThrow(/did not write/);
  });
});

describe("readReleaseUpdateInfo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-rehash-read-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects channel files that disagree about the installer digest", async () => {
    const a = randomBytes(10);
    const b = randomBytes(10);
    await writeFile(join(dir, "latest.yml"), updateInfo(digest(a), 10));
    await writeFile(join(dir, "alpha.yml"), updateInfo(digest(b), 10));
    await expect(readReleaseUpdateInfo(dir)).rejects.toThrow(/disagrees/);
  });
});
