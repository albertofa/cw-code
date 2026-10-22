import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReleasePlan } from "./planValidation.ts";
import { appImageNameFor, blockMapShapeErrors, debNameFor, installerNameFor, publishableAssetNames, stageReleaseSet, validateReleaseAssets } from "./releaseAssets.ts";
import type { SigningManifest } from "./signingManifest.ts";
import { parseUpdateInfo, readReleaseText, withReleaseText } from "./updateInfoYaml.ts";

const VERSION = "1.2.0-alpha.3";
const INSTALLER = installerNameFor(VERSION);
const APPIMAGE = appImageNameFor(VERSION);
const DEB = debNameFor(VERSION);
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

function bareFeed(version: string, sha512: string, size: number, installer = INSTALLER): string {
  return `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${size}\npath: ${installer}\nsha512: ${sha512}\nreleaseDate: '2026-09-25T06:00:00.000Z'\n`;
}

function feed(version: string, sha512: string, size: number, installer = INSTALLER): string {
  return withReleaseText(bareFeed(version, sha512, size, installer), { releaseName: PLAN.tag, releaseNotes: PLAN.notes });
}

function bareLinuxFeed(version: string, appImage: Buffer, deb: Buffer, overrides: { path?: string; appImageSha512?: string; debSha512?: string; debSize?: number; withDeb?: boolean } = {}): string {
  const appImageSha512 = overrides.appImageSha512 ?? digest(appImage);
  const entries = [
    `  - url: ${appImageNameFor(version)}\n    sha512: ${appImageSha512}\n    size: ${appImage.length}\n    blockMapSize: 99`,
    ...(overrides.withDeb === false ? [] : [`  - url: ${debNameFor(version)}\n    sha512: ${overrides.debSha512 ?? digest(deb)}\n    size: ${overrides.debSize ?? deb.length}`])
  ];
  return `version: ${version}\nfiles:\n${entries.join("\n")}\npath: ${overrides.path ?? appImageNameFor(version)}\nsha512: ${appImageSha512}\nreleaseDate: '2026-09-25T06:00:00.000Z'\n`;
}

function linuxFeed(version: string, appImage: Buffer, deb: Buffer, overrides: Parameters<typeof bareLinuxFeed>[3] = {}): string {
  return withReleaseText(bareLinuxFeed(version, appImage, deb, overrides), { releaseName: PLAN.tag, releaseNotes: PLAN.notes });
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
  let appImage: Buffer;
  let deb: Buffer;
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
      const linuxText = linuxFeed(VERSION, appImage, deb);
      await writeFile(join(target, APPIMAGE), appImage);
      await writeFile(join(target, DEB), deb);
      await writeFile(join(target, "latest-linux.yml"), linuxText);
      await writeFile(join(target, "alpha-linux.yml"), linuxText);
    }
  }

  async function writeLinuxFeeds(text: string): Promise<void> {
    await Promise.all(["latest-linux.yml", "alpha-linux.yml"].map((name) => writeFile(join(dir, name), text)));
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
    appImage = randomBytes(2048);
    deb = randomBytes(1024);
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

  it("accepts a set staged from a deb-first Linux feed", async () => {
    const linuxDir = join(root, "linux-build");
    const windowsDir = join(root, "windows-build");
    const staged = join(root, "staged");
    await mkdir(linuxDir);
    await mkdir(windowsDir);
    await writeFile(join(linuxDir, APPIMAGE), appImage);
    await writeFile(join(linuxDir, DEB), deb);
    const entry = (url: string, bytes: Buffer): string => `  - url: ${url}\n    sha512: ${digest(bytes)}\n    size: ${bytes.length}`;
    await writeFile(
      join(linuxDir, "latest-linux.yml"),
      `version: ${VERSION}\nfiles:\n${entry(DEB, deb)}\n${entry(APPIMAGE, appImage)}\npath: ${DEB}\nsha512: ${digest(deb)}\nreleaseDate: '2026-09-25T06:00:00.000Z'\n`
    );
    for (const name of [INSTALLER, `${INSTALLER}.blockmap`, "signing.json", "latest.yml"]) {
      await writeFile(join(windowsDir, name), await readFile(join(dir, name)));
    }
    await stageReleaseSet(windowsDir, staged, PLAN, linuxDir);
    expect((await validate({ dir: staged })).errors).toEqual([]);
  });

  it("orders uploads so the channel's own feed file comes last", () => {
    expect(publishableAssetNames(PLAN)).toEqual([
      INSTALLER,
      `${INSTALLER}.blockmap`,
      "signing.json",
      APPIMAGE,
      DEB,
      "latest.yml",
      "latest-linux.yml",
      "alpha.yml",
      "alpha-linux.yml"
    ]);
    expect(publishableAssetNames({ version: "1.2.0", channel: "stable" }).slice(-4)).toEqual(["alpha.yml", "alpha-linux.yml", "latest.yml", "latest-linux.yml"]);
  });

  it("names the Linux assets after the version", () => {
    expect(appImageNameFor("1.2.0")).toBe("cw-code-1.2.0-x86_64.AppImage");
    expect(debNameFor("1.2.0")).toBe("cw-code-1.2.0-amd64.deb");
  });

  it("rejects a missing Linux asset", async () => {
    await rm(join(dir, DEB));
    await rm(join(dir, "alpha-linux.yml"));
    const text = await errors();
    expect(text).toMatch(new RegExp(`${DEB.replaceAll(".", "\\.")} is missing`));
    expect(text).toMatch(/alpha-linux.yml is missing/);
  });

  it("requires alpha-linux.yml to be a byte copy of latest-linux.yml", async () => {
    await writeFile(join(dir, "alpha-linux.yml"), `${linuxFeed(VERSION, appImage, deb)}\n`);
    expect(await errors()).toMatch(/alpha-linux.yml must be a byte copy of latest-linux.yml/);
  });

  it("requires the Linux feed to point at the AppImage", async () => {
    await writeLinuxFeeds(linuxFeed(VERSION, appImage, deb, { path: DEB }));
    expect(await errors()).toMatch(/latest-linux.yml: .*does not match top-level path "cw-code-1.2.0-alpha.3-amd64.deb"/);
  });

  it("requires the Linux feed to list the AppImage then the deb", async () => {
    await writeLinuxFeeds(linuxFeed(VERSION, appImage, deb, { withDeb: false }));
    expect(await errors()).toMatch(/latest-linux.yml files must be exactly .*AppImage, .*deb, got .*AppImage$/m);
  });

  it("rejects a Linux feed whose version, digests or sizes disagree with the bytes", async () => {
    await writeLinuxFeeds(linuxFeed("1.2.0-alpha.4", appImage, deb));
    expect(await errors()).toMatch(/latest-linux.yml version 1.2.0-alpha.4 differs from the plan version/);
    await writeLinuxFeeds(linuxFeed(VERSION, appImage, deb, { appImageSha512: digest(randomBytes(8)) }));
    const appImageErrors = await errors();
    expect(appImageErrors).toMatch(/sha512 for cw-code-1.2.0-alpha.3-x86_64.AppImage does not match its bytes/);
    expect(appImageErrors).toMatch(/top-level sha512 does not match the AppImage bytes/);
    await writeLinuxFeeds(linuxFeed(VERSION, appImage, deb, { debSha512: digest(randomBytes(8)) }));
    expect(await errors()).toMatch(/sha512 for cw-code-1.2.0-alpha.3-amd64.deb does not match its bytes/);
    await writeLinuxFeeds(linuxFeed(VERSION, appImage, deb, { debSize: deb.length + 1 }));
    expect(await errors()).toMatch(/size 1025 for cw-code-1.2.0-alpha.3-amd64.deb does not match its bytes \(1024\)/);
  });

  it("requires the Linux feed to carry this release's name and notes", async () => {
    await writeLinuxFeeds(bareLinuxFeed(VERSION, appImage, deb));
    const missing = await errors();
    expect(missing).toMatch(/latest-linux.yml releaseName null must be v1.2.0-alpha.3/);
    expect(missing).toMatch(/latest-linux.yml releaseNotes differ from the plan notes/);
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

  it("requires the feed to carry this release's name and notes so clients never show another release's text", async () => {
    const write = (text: string) => Promise.all(["latest.yml", "alpha.yml"].map((name) => writeFile(join(dir, name), text)));
    await write(bareFeed(VERSION, digest(installer), installer.length));
    const missing = await errors();
    expect(missing).toMatch(/releaseName null must be v1.2.0-alpha.3/);
    expect(missing).toMatch(/releaseNotes differ from the plan notes/);
    await write(withReleaseText(bareFeed(VERSION, digest(installer), installer.length), { releaseName: "v1.2.0-alpha.2", releaseNotes: "older notes" }));
    const stale = await errors();
    expect(stale).toMatch(/releaseName "v1.2.0-alpha.2" must be v1.2.0-alpha.3/);
    expect(stale).toMatch(/releaseNotes differ/);
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
    expect(await errors({ signing: unsigned, expectedPublisher: undefined })).toMatch(/signing.json is not a production manifest \(mode unsigned\)/);
    expect(await errors({ expectedPublisher: "Someone Else" })).toMatch(/publisher "SignPath Foundation" differs from the expected "Someone Else"/);
  });

  it("accepts a production unsigned manifest only when unsigned was the planned signing mode", async () => {
    const unsigned = { ...manifest, mode: "unsigned", production: true, publisher: null };
    expect((await validate({ signing: unsigned, expectedSigningMode: "unsigned", expectedPublisher: undefined })).ok).toBe(true);
    expect(await errors({ signing: unsigned, expectedSigningMode: "signpath", expectedPublisher: undefined })).toMatch(
      /signing.json mode unsigned differs from the planned signing mode signpath/
    );
    expect(await errors({ expectedSigningMode: "unsigned" })).toMatch(/signing.json mode signpath differs from the planned signing mode unsigned/);
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
    const linuxFrom = join(root, "linux");
    await mkdir(linuxFrom, { recursive: true });
    for (const name of [APPIMAGE, DEB, "builder-debug.yml"]) {
      await writeFile(join(linuxFrom, name), name);
    }
    await writeFile(join(linuxFrom, "latest-linux.yml"), bareLinuxFeed(VERSION, Buffer.from(APPIMAGE), Buffer.from(DEB)));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function stage(to = "to"): Promise<string[]> {
    return stageReleaseSet(join(root, "from"), join(root, to), PLAN, join(root, "linux"));
  }

  it("copies exactly the publishable files, adds the plan's release name and notes to latest.yml and writes alpha.yml as its byte copy", async () => {
    await writeFile(join(root, "from", "latest.yml"), bareFeed(VERSION, "x", 1));
    const staged = await stage();
    expect(staged).toContain("alpha.yml (latest.yml with releaseName and releaseNotes from the plan)");
    expect((await readdir(join(root, "to"))).sort()).toEqual([...publishableAssetNames(PLAN)].sort());
    const latest = await readFile(join(root, "to", "latest.yml"));
    expect(latest.equals(await readFile(join(root, "to", "alpha.yml")))).toBe(true);
    expect(readReleaseText(latest.toString("utf8"))).toEqual({ releaseName: PLAN.tag, releaseNotes: PLAN.notes });
    expect(latest.toString("utf8").startsWith(bareFeed(VERSION, "x", 1))).toBe(true);
  });

  it("copies the AppImage and deb from the Linux directory and writes both Linux feeds from latest-linux.yml with the plan's release text", async () => {
    const bare = bareLinuxFeed(VERSION, Buffer.from("a"), Buffer.from("b"));
    await writeFile(join(root, "linux", "latest-linux.yml"), bare);
    const staged = await stage();
    expect(staged).toContain("alpha-linux.yml (latest-linux.yml with releaseName and releaseNotes from the plan)");
    expect((await readFile(join(root, "to", APPIMAGE), "utf8"))).toBe(APPIMAGE);
    expect((await readFile(join(root, "to", DEB), "utf8"))).toBe(DEB);
    const latest = await readFile(join(root, "to", "latest-linux.yml"));
    expect(latest.equals(await readFile(join(root, "to", "alpha-linux.yml")))).toBe(true);
    expect(readReleaseText(latest.toString("utf8"))).toEqual({ releaseName: PLAN.tag, releaseNotes: PLAN.notes });
    expect(latest.toString("utf8").startsWith(bare)).toBe(true);
  });

  it("stages a deb-first Linux feed in canonical order with the AppImage as the top-level file and keeps the other fields", async () => {
    const appImageBytes = randomBytes(2048);
    const debBytes = randomBytes(1024);
    await writeFile(join(root, "linux", APPIMAGE), appImageBytes);
    await writeFile(join(root, "linux", DEB), debBytes);
    const debFirst = [
      `version: ${VERSION}`,
      "files:",
      `  - url: ${DEB}`,
      `    sha512: ${digest(debBytes)}`,
      `    size: ${debBytes.length}`,
      `  - url: ${APPIMAGE}`,
      `    sha512: ${digest(appImageBytes)}`,
      `    size: ${appImageBytes.length}`,
      "    blockMapSize: 99",
      `path: ${DEB}`,
      `sha512: ${digest(debBytes)}`,
      "releaseDate: '2026-09-25T06:00:00.000Z'",
      ""
    ].join("\n");
    await writeFile(join(root, "linux", "latest-linux.yml"), debFirst);
    await writeFile(join(root, "from", "latest.yml"), feed(VERSION, digest(Buffer.from(INSTALLER)), INSTALLER.length));
    await stage();

    const staged = await readFile(join(root, "to", "latest-linux.yml"), "utf8");
    const info = parseUpdateInfo(staged);
    expect(info.files.map((file) => [file.url, file.sha512, file.size])).toEqual([
      [APPIMAGE, digest(appImageBytes), appImageBytes.length],
      [DEB, digest(debBytes), debBytes.length]
    ]);
    expect(info.path).toBe(APPIMAGE);
    expect(info.sha512).toBe(digest(appImageBytes));
    expect(staged).toContain("    blockMapSize: 99\n");
    expect(staged).toContain("releaseDate: '2026-09-25T06:00:00.000Z'\n");
    expect(await readFile(join(root, "to", "alpha-linux.yml"), "utf8")).toBe(staged);
  });

  it("refuses a Linux feed that misses the AppImage or the deb or lists an extra file", async () => {
    const withEntries = (urls: string[]): string =>
      `version: ${VERSION}\nfiles:\n${urls.map((url) => `  - url: ${url}\n    sha512: x\n    size: 1`).join("\n")}\npath: ${urls[0]}\nsha512: x\n`;
    for (const urls of [[APPIMAGE], [DEB], [DEB, APPIMAGE, "other.zip"], [APPIMAGE, APPIMAGE]]) {
      await writeFile(join(root, "linux", "latest-linux.yml"), withEntries(urls));
      await expect(stage(`bad-${urls.length}-${urls[0]}`)).rejects.toThrow(/files must be exactly/);
    }
  });

  it("accepts an identical alpha.yml, refuses a different one, a non-empty target or a missing input", async () => {
    await writeFile(join(root, "from", "alpha.yml"), "own alpha");
    await expect(stage()).rejects.toThrow(/alpha.yml .* differs from latest.yml/);
    await writeFile(join(root, "from", "alpha.yml"), "latest.yml");
    await stage();
    await expect(stage()).rejects.toThrow(/not empty/);
    await rm(join(root, "from", "signing.json"));
    await expect(stage("fresh")).rejects.toThrow(/signing.json is missing/);
  });

  it("accepts an identical alpha-linux.yml, refuses a different one, a missing Linux feed or a missing Linux asset", async () => {
    await writeFile(join(root, "linux", "alpha-linux.yml"), "own alpha");
    await expect(stage()).rejects.toThrow(/alpha-linux.yml .* differs from latest-linux.yml/);
    await writeFile(join(root, "linux", "alpha-linux.yml"), await readFile(join(root, "linux", "latest-linux.yml")));
    await stage();
    await rm(join(root, "linux", DEB));
    await expect(stage("fresh")).rejects.toThrow(/amd64.deb is missing/);
    await rm(join(root, "linux", "latest-linux.yml"));
    await expect(stage("other")).rejects.toThrow(/latest-linux.yml is missing/);
  });
});
