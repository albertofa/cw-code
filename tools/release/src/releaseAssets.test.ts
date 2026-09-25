import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReleasePlan } from "./planValidation.ts";
import { blockMapShapeErrors, installerNameFor, publishableAssetNames, stageReleaseSet, validateReleaseAssets } from "./releaseAssets.ts";
import type { SigningManifest } from "./signingManifest.ts";

const VERSION = "1.2.0-alpha.3";
const INSTALLER = installerNameFor(VERSION);
const SOURCE_SHA = "c".repeat(40);
const RUN_ID = "777";
const PUBLISHER = "SignPath Foundation";

const PLAN: ReleasePlan = {
  schema: 1,
  channel: "alpha",
  version: VERSION,
  tag: `v${VERSION}`,
  sourceSha: SOURCE_SHA,
  previousTag: "v1.2.0-alpha.2",
  prerelease: true,
  makeLatest: false,
  notes: "## Fixes\n\n- fix: something",
  createdAt: "2026-09-25T06:00:00.000Z"
};

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function feed(version: string, sha512: string, size: number, installer = INSTALLER): string {
  return `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${size}\npath: ${installer}\nsha512: ${sha512}\nreleaseDate: '2026-09-25T06:00:00.000Z'\n`;
}

function blockMapFor(size: number): Buffer {
  return gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: ["a", "b"], sizes: [size - 100, 100] }] }));
}

describe("validateReleaseAssets", () => {
  let root: string;
  let dir: string;
  let full: string;
  let installer: Buffer;
  let app: Buffer;
  let blockMap: Buffer;
  let manifest: SigningManifest;

  async function writeSet(target: string, withApp: boolean): Promise<void> {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, INSTALLER), installer);
    await writeFile(join(target, `${INSTALLER}.blockmap`), blockMap);
    const text = feed(VERSION, digest(installer), installer.length);
    await writeFile(join(target, "latest.yml"), text);
    await writeFile(join(target, "signing.json"), JSON.stringify(manifest));
    if (withApp) {
      await mkdir(join(target, "win-unpacked"), { recursive: true });
      await writeFile(join(target, "win-unpacked", "cw-code.exe"), app);
    } else {
      await writeFile(join(target, "alpha.yml"), text);
    }
  }

  function validate(overrides: Partial<Parameters<typeof validateReleaseAssets>[0]> = {}): ReturnType<typeof validateReleaseAssets> {
    return validateReleaseAssets({ dir, plan: PLAN, signing: manifest, runId: RUN_ID, requireProduction: true, expectedPublisher: PUBLISHER, ...overrides });
  }

  async function errors(overrides: Partial<Parameters<typeof validateReleaseAssets>[0]> = {}): Promise<string> {
    return (await validate(overrides)).errors.join("\n");
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-release-assets-"));
    dir = join(root, "set");
    full = join(root, "full");
    installer = randomBytes(4096);
    app = randomBytes(512);
    blockMap = blockMapFor(installer.length);
    const signed = { status: "Valid", signed: true, subject: "CN=SignPath Foundation, O=SignPath Foundation", timestamped: true };
    manifest = {
      mode: "signpath",
      production: true,
      publisher: PUBLISHER,
      version: VERSION,
      sourceSha: SOURCE_SHA,
      runId: RUN_ID,
      verifiedAt: "2026-09-25T06:30:00.000Z",
      files: [
        { path: "win-unpacked/cw-code.exe", role: "first-party", sha512: digest(app), ...signed },
        { path: INSTALLER, role: "first-party", sha512: digest(installer), ...signed }
      ],
      blockMap: { path: `${INSTALLER}.blockmap`, sha512: digest(blockMap), size: blockMap.length }
    };
    await writeSet(dir, false);
    await writeSet(full, true);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts the complete signed set and reports every asset with its digest", async () => {
    const report = await validate({ unpackedRoot: full });
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ ok: true, version: VERSION, channel: "alpha", tag: `v${VERSION}`, sourceSha: SOURCE_SHA, signingMode: "signpath", production: true });
    expect(report.assets.map((asset) => asset.name)).toEqual(publishableAssetNames(PLAN));
    expect(report.assets[0]).toEqual({ name: INSTALLER, size: installer.length, sha512: digest(installer) });
  });

  it("orders uploads so the channel's own feed file comes last", () => {
    expect(publishableAssetNames(PLAN)).toEqual([INSTALLER, `${INSTALLER}.blockmap`, "signing.json", "latest.yml", "alpha.yml"]);
    expect(publishableAssetNames({ version: "1.2.0", channel: "stable" }).slice(-2)).toEqual(["alpha.yml", "latest.yml"]);
  });

  it("rejects extra files, directories and missing assets", async () => {
    await writeFile(join(dir, "builder-debug.yml"), "x");
    await mkdir(join(dir, "win-unpacked"));
    await rm(join(dir, "alpha.yml"));
    const text = await errors();
    expect(text).toMatch(/unexpected file builder-debug.yml/);
    expect(text).toMatch(/unexpected directory win-unpacked/);
    expect(text).toMatch(/alpha.yml is missing/);
  });

  it("requires alpha.yml to be a byte copy of latest.yml", async () => {
    await writeFile(join(dir, "alpha.yml"), `${feed(VERSION, digest(installer), installer.length)}\n`);
    expect(await errors()).toMatch(/alpha.yml must be a byte copy of latest.yml/);
  });

  it("rejects a feed whose version, installer name, digest or size disagrees with the plan and the bytes", async () => {
    const write = (text: string) => Promise.all(["latest.yml", "alpha.yml"].map((name) => writeFile(join(dir, name), text)));
    await write(feed("1.2.0-alpha.4", digest(installer), installer.length));
    expect(await errors()).toMatch(/version 1.2.0-alpha.4 differs from the plan version/);
    await write(feed(VERSION, digest(randomBytes(8)), installer.length));
    expect(await errors()).toMatch(/sha512 does not match the installer bytes/);
    await write(feed(VERSION, digest(installer), installer.length + 1));
    expect(await errors()).toMatch(/does not match the installer/);
    await write(feed(VERSION, digest(installer), installer.length, "cw-code-Setup-1.2.0-alpha.3-arm64.exe"));
    expect(await errors()).toMatch(/path cw-code-Setup-1.2.0-alpha.3-arm64.exe must be cw-code-Setup-1.2.0-alpha.3-x64.exe/);
  });

  it("rejects installer or blockmap bytes that differ from signing.json", async () => {
    await writeFile(join(dir, `${INSTALLER}.blockmap`), blockMapFor(installer.length + 1));
    const tampered = await errors();
    expect(tampered).toMatch(/blockmap bytes differ from the blockmap recorded in signing.json/);
    expect(tampered).toMatch(/blockmap covers 4097 bytes but the installer has 4096/);
    const other = randomBytes(4096);
    await writeFile(join(dir, INSTALLER), other);
    const text = feed(VERSION, digest(other), other.length);
    await Promise.all(["latest.yml", "alpha.yml"].map((name) => writeFile(join(dir, name), text)));
    expect(await errors()).toMatch(/bytes differ from the installer recorded in signing.json/);
  });

  it("binds signing.json to the plan's version and source SHA and to this run", async () => {
    expect(await errors({ runId: "778" })).toMatch(/runId "777" differs from the expected "778"/);
    expect(await errors({ signing: { ...manifest, sourceSha: "d".repeat(40) } })).toMatch(/sourceSha .* differs from the expected/);
    expect(await errors({ plan: { ...PLAN, version: "1.2.0-alpha.4", tag: "v1.2.0-alpha.4" } })).toMatch(/version "1.2.0-alpha.3" differs/);
    expect(await errors({ runId: "abc" })).toMatch(/run id must be numeric/);
  });

  it("refuses non-production manifests when production is required, and a different publisher", async () => {
    const unsigned = { ...manifest, mode: "unsigned", production: false, publisher: null };
    expect((await validate({ signing: unsigned, requireProduction: false, expectedPublisher: undefined })).ok).toBe(true);
    expect(await errors({ signing: unsigned, expectedPublisher: undefined })).toMatch(/not a production signpath manifest/);
    expect(await errors({ expectedPublisher: "Someone Else" })).toMatch(/publisher "SignPath Foundation" differs from the expected "Someone Else"/);
  });

  it("rejects an invalid plan or signing manifest before trusting anything", async () => {
    expect(await errors({ plan: { ...PLAN, tag: "v9.9.9" } })).toMatch(/plan: tag/);
    expect(await errors({ signing: { ...manifest, blockMap: null } })).toMatch(/signing.json: blockMap must be an object/);
  });

  it("re-hashes the full release set, including win-unpacked, when given", async () => {
    await writeFile(join(full, "win-unpacked", "cw-code.exe"), randomBytes(512));
    expect(await errors({ unpackedRoot: full })).toMatch(/full release set: win-unpacked\/cw-code.exe no longer matches/);
  });
});

describe("blockMapShapeErrors", () => {
  it("accepts an electron-builder v2 blockmap that covers the installer exactly", () => {
    expect(blockMapShapeErrors(blockMapFor(1000), 1000)).toEqual([]);
  });

  it("rejects non-gzip data, another version or more than one file", () => {
    expect(blockMapShapeErrors(Buffer.from("plain"), 10).join()).toMatch(/not gzip-compressed JSON/);
    expect(blockMapShapeErrors(gzipSync(JSON.stringify({ version: "1", files: [] })), 10).join()).toMatch(/version must be "2"/);
    expect(blockMapShapeErrors(gzipSync(JSON.stringify({ version: "2", files: [] })), 10).join()).toMatch(/exactly one file/);
  });
});

describe("stageReleaseSet", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-stage-"));
    const from = join(root, "from");
    await mkdir(join(from, "win-unpacked"), { recursive: true });
    for (const name of [INSTALLER, `${INSTALLER}.blockmap`, "signing.json", "latest.yml", "verify-signatures.json", "rehash.json"]) {
      await writeFile(join(from, name), name);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies exactly the publishable files and generates alpha.yml as a byte copy of latest.yml", async () => {
    const staged = await stageReleaseSet(join(root, "from"), join(root, "to"), PLAN);
    expect(staged).toContain("alpha.yml (generated from latest.yml)");
    expect((await readdir(join(root, "to"))).sort()).toEqual([...publishableAssetNames(PLAN)].sort());
    expect(await readFile(join(root, "to", "alpha.yml"), "utf8")).toBe("latest.yml");
  });

  it("keeps an existing alpha.yml and refuses a non-empty target or a missing input", async () => {
    await writeFile(join(root, "from", "alpha.yml"), "own alpha");
    await stageReleaseSet(join(root, "from"), join(root, "to"), PLAN);
    expect(await readFile(join(root, "to", "alpha.yml"), "utf8")).toBe("own alpha");
    await expect(stageReleaseSet(join(root, "from"), join(root, "to"), PLAN)).rejects.toThrow(/not empty/);
    await rm(join(root, "from", "signing.json"));
    await expect(stageReleaseSet(join(root, "from"), join(root, "fresh"), PLAN)).rejects.toThrow(/signing.json is missing/);
  });
});
