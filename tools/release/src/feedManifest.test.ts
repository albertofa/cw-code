import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateLinuxReleaseFeed, validateReleaseFeed } from "./feedManifest.ts";

function manifest(version: string, installer: string, sha512: string, size: number): string {
  return [`version: ${version}`, "files:", `  - url: ${installer}`, `    sha512: ${sha512}`, `    size: ${size}`, `path: ${installer}`, `sha512: ${sha512}`, "releaseDate: '2026-09-25T00:00:00.000Z'", ""].join("\n");
}

describe("validateReleaseFeed", () => {
  let dir: string;
  const bytes = randomBytes(4096);
  const digest = createHash("sha512").update(bytes).digest("base64");
  const ALPHA = "cw-code-updatetest-Setup-0.0.1-alpha.9001-x64.exe";
  const STABLE = "cw-code-updatetest-Setup-0.0.2-x64.exe";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-feed-manifest-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts an alpha release whose manifest matches the installer bytes", async () => {
    await writeFile(join(dir, ALPHA), bytes);
    await writeFile(join(dir, `${ALPHA}.blockmap`), "blockmap");
    await writeFile(join(dir, "alpha.yml"), manifest("0.0.1-alpha.9001", ALPHA, digest, bytes.length));
    const report = await validateReleaseFeed(dir, { version: "0.0.1-alpha.9001", channelFiles: ["alpha.yml"], requireBlockMap: true });
    expect(report).toMatchObject({ version: "0.0.1-alpha.9001", installer: ALPHA, channelFiles: ["alpha.yml"], sizeBytes: 4096, blockMap: true, errors: [] });
  });

  it("accepts a stable release published on every channel", async () => {
    await writeFile(join(dir, STABLE), bytes);
    for (const name of ["latest.yml", "alpha.yml"]) await writeFile(join(dir, name), manifest("0.0.2", STABLE, digest, bytes.length));
    const report = await validateReleaseFeed(dir, { channelFiles: ["latest.yml", "alpha.yml"] });
    expect(report.errors).toEqual([]);
    expect(report.blockMap).toBe(false);
  });

  it("reports a checksum or size that no longer matches the installer", async () => {
    await writeFile(join(dir, ALPHA), bytes);
    await writeFile(join(dir, "alpha.yml"), manifest("0.0.1-alpha.9001", ALPHA, createHash("sha512").update("other").digest("base64"), bytes.length + 1));
    const report = await validateReleaseFeed(dir);
    expect(report.errors).toEqual([`installer is 4096 bytes but the update info says 4097`, "installer sha512 does not match the update info"]);
  });

  it("reports a missing installer, blockmap, channel file and version mismatch", async () => {
    await writeFile(join(dir, "alpha.yml"), manifest("0.0.1-alpha.9001", ALPHA, digest, bytes.length));
    const report = await validateReleaseFeed(dir, { version: "0.0.1-alpha.9002", channelFiles: ["latest.yml"], requireBlockMap: true });
    expect(report.errors).toEqual([
      "update info version is 0.0.1-alpha.9001, expected 0.0.1-alpha.9002",
      "latest.yml is missing",
      `installer ${ALPHA} referenced by alpha.yml does not exist`
    ]);
  });

  it("reports versions cw-code would ignore and channel files that do not fit the version", async () => {
    await writeFile(join(dir, ALPHA), bytes);
    await writeFile(join(dir, "latest.yml"), manifest("0.0.1-beta.1", ALPHA, digest, bytes.length));
    expect((await validateReleaseFeed(dir)).errors).toEqual(["version 0.0.1-beta.1 is neither X.Y.Z nor X.Y.Z-alpha.N, so cw-code would ignore it"]);
    await writeFile(join(dir, "latest.yml"), manifest("0.0.1-alpha.9001", ALPHA, digest, bytes.length));
    expect((await validateReleaseFeed(dir)).errors).toEqual(["alpha version 0.0.1-alpha.9001 has no alpha.yml"]);
  });

  it("reports unreadable or missing manifests instead of throwing", async () => {
    expect((await validateReleaseFeed(dir)).errors[0]).toMatch(/No update info file/);
    await writeFile(join(dir, "alpha.yml"), "version: 1\n");
    expect((await validateReleaseFeed(dir)).errors[0]).toMatch(/missing "path"/);
  });
});

describe("validateLinuxReleaseFeed", () => {
  let dir: string;
  const VERSION = "0.0.1-alpha.22";
  const APPIMAGE = `cw-code-${VERSION}-x86_64.AppImage`;
  const DEB = `cw-code-${VERSION}-amd64.deb`;
  const appImage = randomBytes(4096);
  const deb = randomBytes(2048);
  const sha = (bytes: Buffer): string => createHash("sha512").update(bytes).digest("base64");

  function linuxManifest(version = VERSION, debSha512 = sha(deb)): string {
    return [
      `version: ${version}`,
      "files:",
      `  - url: ${APPIMAGE}`,
      `    sha512: ${sha(appImage)}`,
      `    size: ${appImage.length}`,
      "    blockMapSize: 99",
      `  - url: ${DEB}`,
      `    sha512: ${debSha512}`,
      `    size: ${deb.length}`,
      `path: ${APPIMAGE}`,
      `sha512: ${sha(appImage)}`,
      ""
    ].join("\n");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-linux-feed-"));
    await writeFile(join(dir, APPIMAGE), appImage);
    await writeFile(join(dir, DEB), deb);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts an alpha Linux feed whose two files match their bytes and describes both", async () => {
    for (const name of ["latest-linux.yml", "alpha-linux.yml"]) await writeFile(join(dir, name), linuxManifest());
    await writeFile(join(dir, "latest.yml"), "not a Linux feed");
    const report = await validateLinuxReleaseFeed(dir);
    expect(report).toMatchObject({
      version: VERSION,
      channelFiles: ["latest-linux.yml", "alpha-linux.yml"],
      appImage: { name: APPIMAGE, size: 4096, sha512: sha(appImage) },
      deb: { name: DEB, size: 2048, sha512: sha(deb) },
      errors: []
    });
  });

  it("reports a missing alpha feed, a feed that is not a byte copy and bytes that do not match", async () => {
    await writeFile(join(dir, "latest-linux.yml"), linuxManifest(VERSION, sha(randomBytes(8))));
    expect((await validateLinuxReleaseFeed(dir)).errors).toEqual([
      `alpha version ${VERSION} has no alpha-linux.yml`,
      `latest-linux.yml sha512 for ${DEB} does not match its bytes`
    ]);
    await writeFile(join(dir, "alpha-linux.yml"), `${linuxManifest()}\n`);
    expect((await validateLinuxReleaseFeed(dir)).errors[0]).toBe("alpha-linux.yml must be a byte copy of latest-linux.yml");
  });

  it("reports a missing feed or package instead of throwing", async () => {
    expect((await validateLinuxReleaseFeed(dir)).errors).toEqual([`latest-linux.yml is missing from ${dir}`]);
    await rm(join(dir, DEB));
    for (const name of ["latest-linux.yml", "alpha-linux.yml"]) await writeFile(join(dir, name), linuxManifest());
    const report = await validateLinuxReleaseFeed(dir);
    expect(report.deb).toBeNull();
    expect(report.errors).toEqual([`${DEB} referenced by latest-linux.yml does not exist`]);
  });
});
