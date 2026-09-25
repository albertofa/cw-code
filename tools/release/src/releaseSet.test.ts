import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyReleaseSet } from "./releaseSet.ts";
import type { SigningManifest } from "./signingManifest.ts";

const INSTALLER = "cw-code-Setup-1.2.0-x64.exe";

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function updateInfo(version: string, sha512: string, size: number): string {
  return `version: ${version}\nfiles:\n  - url: ${INSTALLER}\n    sha512: ${sha512}\n    size: ${size}\npath: ${INSTALLER}\nsha512: ${sha512}\n`;
}

describe("verifyReleaseSet", () => {
  let dir: string;
  let installer: Buffer;
  let app: Buffer;
  let manifest: SigningManifest;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cw-release-set-"));
    installer = randomBytes(1024);
    app = randomBytes(512);
    await mkdir(join(dir, "win-unpacked"));
    await writeFile(join(dir, INSTALLER), installer);
    await writeFile(join(dir, "win-unpacked", "cw-code.exe"), app);
    await writeFile(join(dir, "latest.yml"), updateInfo("1.2.0", digest(installer), installer.length));
    const signed = { status: "Valid", signed: true, subject: "CN=SignPath Foundation", timestamped: true };
    manifest = {
      mode: "signpath",
      production: true,
      publisher: "SignPath Foundation",
      version: "1.2.0",
      sourceSha: "a".repeat(40),
      runId: "1",
      verifiedAt: "2026-09-25T01:00:00.000Z",
      files: [
        { path: "win-unpacked/cw-code.exe", role: "first-party", sha512: digest(app), ...signed },
        { path: INSTALLER, role: "first-party", sha512: digest(installer), ...signed }
      ]
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a release set that matches signing.json and the update info", async () => {
    expect(await verifyReleaseSet(dir, manifest)).toEqual([]);
  });

  it("rejects a file changed after signing.json was written", async () => {
    await writeFile(join(dir, "win-unpacked", "cw-code.exe"), randomBytes(512));
    expect((await verifyReleaseSet(dir, manifest)).join("\n")).toMatch(/cw-code.exe no longer matches/);
  });

  it("rejects a missing listed file", async () => {
    await rm(join(dir, "win-unpacked", "cw-code.exe"));
    expect((await verifyReleaseSet(dir, manifest)).join("\n")).toMatch(/missing from/);
  });

  it("rejects a version that differs from the update info", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo("1.2.1", digest(installer), installer.length));
    expect((await verifyReleaseSet(dir, manifest)).join("\n")).toMatch(/differs from update info version 1.2.1/);
  });

  it("rejects an installer digest that differs from the update info", async () => {
    await writeFile(join(dir, "latest.yml"), updateInfo("1.2.0", digest(randomBytes(4)), installer.length));
    expect((await verifyReleaseSet(dir, manifest)).join("\n")).toMatch(/installer sha512 differs/);
  });

  it("reports a missing update info file", async () => {
    await rm(join(dir, "latest.yml"));
    expect((await verifyReleaseSet(dir, manifest)).join("\n")).toMatch(/No update info file/);
  });
});
