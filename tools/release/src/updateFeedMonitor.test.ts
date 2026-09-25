import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FeedMonitorHttp } from "./clientHttp.ts";
import { planMarker } from "./planMarker.ts";
import { installerNameFor, publishableAssetNames } from "./releaseAssets.ts";
import { parseVersion } from "./semver.ts";
import { type FeedMonitorReport, alphaClientTag, monitorUpdateFeed, monitorUpdateFeedWithRetries, pipelineReleasesOf } from "./updateFeedMonitor.ts";

const BASE = "https://github.com/albertofa/cw-code";
const LISTING = "https://api.github.com/repos/albertofa/cw-code/releases?per_page=100";
const LEGACY = "v0.0.1-alpha.21";

interface Stored {
  status: number;
  body: Buffer;
}

interface ListingEntry {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  assets: { name: string; size: number; state: string }[];
}

interface Repo {
  urls: Map<string, Stored>;
  listing: ListingEntry[];
  feedOrder: string[];
  latestTag: string | null;
}

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function legacyRepo(): Repo {
  return {
    urls: new Map(),
    listing: [{ tag_name: LEGACY, draft: false, prerelease: false, body: "manual release", assets: [{ name: "cw-code.Setup.0.0.1-alpha.21.exe", size: 100, state: "uploaded" }] }],
    feedOrder: [LEGACY],
    latestTag: LEGACY
  };
}

function publish(repo: Repo, version: string, sourceSha: string): void {
  const tag = `v${version}`;
  const channel = parseVersion(version).channel;
  const installerName = installerNameFor(version);
  const installer = randomBytes(4096);
  const blockMap = randomBytes(128);
  const feed = `version: ${version}\nfiles:\n  - url: ${installerName}\n    sha512: ${digest(installer)}\n    size: ${installer.length}\npath: ${installerName}\nsha512: ${digest(installer)}\n`;
  const signed = { status: "Valid", signed: true, subject: "CN=SignPath Foundation", timestamped: true };
  const signing = {
    mode: "signpath",
    production: true,
    publisher: "SignPath Foundation",
    version,
    sourceSha,
    runId: "42",
    verifiedAt: "2026-09-25T06:30:00.000Z",
    files: [
      { path: "win-unpacked/cw-code.exe", role: "first-party", sha512: digest(Buffer.from(`app ${version}`)), ...signed },
      { path: installerName, role: "first-party", sha512: digest(installer), ...signed }
    ],
    blockMap: { path: `${installerName}.blockmap`, sha512: digest(blockMap), size: blockMap.length }
  };
  const download = `${BASE}/releases/download/${tag}`;
  const files: Record<string, Buffer> = {
    [installerName]: installer,
    [`${installerName}.blockmap`]: blockMap,
    "signing.json": Buffer.from(JSON.stringify(signing)),
    "latest.yml": Buffer.from(feed),
    "alpha.yml": Buffer.from(feed)
  };
  for (const [name, body] of Object.entries(files)) repo.urls.set(`${download}/${name}`, { status: 200, body });
  repo.listing.unshift({
    tag_name: tag,
    draft: false,
    prerelease: channel === "alpha",
    body: `## Fixes\n\n- something\n\n${planMarker(sourceSha)}\n`,
    assets: publishableAssetNames({ version, channel }).map((name) => ({ name, size: files[name].length, state: "uploaded" }))
  });
  repo.feedOrder.unshift(tag);
  if (channel === "stable") repo.latestTag = tag;
}

function responsesOf(repo: Repo): Map<string, Stored> {
  const urls = new Map(repo.urls);
  urls.set(LISTING, { status: 200, body: Buffer.from(JSON.stringify(repo.listing)) });
  const entries = repo.feedOrder.map((tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="${BASE}/releases/tag/${tag}"/><title>${tag}</title></entry>`);
  urls.set(`${BASE}/releases.atom`, { status: 200, body: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`) });
  if (repo.latestTag) {
    urls.set(`${BASE}/releases/latest`, { status: 200, body: Buffer.from(JSON.stringify({ tag_name: repo.latestTag })) });
    const latestFeed = repo.urls.get(`${BASE}/releases/download/${repo.latestTag}/latest.yml`);
    if (latestFeed) urls.set(`${BASE}/releases/latest/download/latest.yml`, latestFeed);
  }
  return urls;
}

interface FakeHttp extends FeedMonitorHttp {
  seen: string[];
}

function httpFor(responses: Map<string, Stored>): FakeHttp {
  const seen: string[] = [];
  const get = (method: string, url: string): Stored => {
    seen.push(`${method} ${url}`);
    return responses.get(url) ?? { status: 404, body: Buffer.from("Not Found") };
  };
  return {
    seen,
    async text(url) {
      const response = get("text", url);
      return { status: response.status, body: response.body.toString("utf8") };
    },
    async digest(url) {
      const response = get("digest", url);
      return { status: response.status, sha512: digest(response.body), size: response.body.length };
    },
    async size(url) {
      const response = get("size", url);
      return { status: response.status === 200 ? 206 : response.status, size: response.status === 200 ? response.body.length : null };
    },
    async api(url) {
      const response = get("api", url);
      return { status: response.status, body: response.body.toString("utf8") };
    }
  };
}

function run(repo: Repo, verifyInstallerDigest = false, responses = responsesOf(repo)): Promise<FeedMonitorReport> {
  return monitorUpdateFeed({ owner: "albertofa", repo: "cw-code", http: httpFor(responses), verifyInstallerDigest });
}

function failures(report: FeedMonitorReport): string[] {
  return report.channels.flatMap((channel) => channel.checks.filter((entry) => !entry.ok).map((entry) => `${channel.channel} ${entry.name}: ${entry.detail}`));
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("monitorUpdateFeed", () => {
  it("reports both feeds as not published yet while only the legacy manual releases exist", async () => {
    const http = httpFor(responsesOf(legacyRepo()));
    const report = await monitorUpdateFeed({ owner: "albertofa", repo: "cw-code", http, verifyInstallerDigest: false });
    expect(report.ok).toBe(true);
    expect(report.channels.map((channel) => channel.status)).toEqual(["not-yet", "not-yet"]);
    expect(report.channels[0].notice).toContain(`resolves to ${LEGACY}`);
    expect(report.channels[1].notice).toContain(`resolves alpha clients to ${LEGACY}`);
    expect(report.summary).toBe("Update feed ok: stable: no pipeline-built release yet; alpha: no pipeline-built release yet");
    expect(http.seen).toEqual([`api ${LISTING}`, `text ${BASE}/releases/latest`, `text ${BASE}/releases.atom`]);
  });

  it("validates the bootstrap alpha for alpha clients while stable stays not published", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const http = httpFor(responsesOf(repo));
    const report = await monitorUpdateFeed({ owner: "albertofa", repo: "cw-code", http, verifyInstallerDigest: false });
    expect(failures(report)).toEqual([]);
    expect(report.ok).toBe(true);
    const [stable, alpha] = report.channels;
    expect(stable.status).toBe("not-yet");
    expect(alpha).toMatchObject({ status: "healthy", tag: "v0.0.1-alpha.22", sourceSha: SHA_A });
    expect(alpha.checks.map((entry) => entry.name)).toEqual(["atom-feed", "channel-manifest", "assets", "feed-copy", "installer", "signing", "blockmap"]);
    expect(report.summary).toBe(`Update feed ok: stable: no pipeline-built release yet; alpha v0.0.1-alpha.22 (${SHA_A.slice(0, 12)}) ok`);
    const installer = `${BASE}/releases/download/v0.0.1-alpha.22/${installerNameFor("0.0.1-alpha.22")}`;
    expect(http.seen).toContain(`size ${installer}`);
    expect(http.seen).not.toContain(`digest ${installer}`);
  });

  it("checks what stable clients resolve and lets alpha clients take the newer stable", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    publish(repo, "0.0.1-alpha.23", SHA_B);
    publish(repo, "0.0.1", SHA_B);
    const report = await run(repo);
    expect(failures(report)).toEqual([]);
    expect(report.channels.map((channel) => [channel.channel, channel.status, channel.tag])).toEqual([
      ["stable", "healthy", "v0.0.1"],
      ["alpha", "healthy", "v0.0.1"]
    ]);
    expect(report.channels[0].checks.map((entry) => entry.name)).toEqual(["latest-release", "channel-manifest", "assets", "feed-copy", "installer", "signing", "blockmap"]);
  });

  it("fails when /releases/latest does not resolve to the highest pipeline-built stable", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1", SHA_A);
    publish(repo, "0.0.2", SHA_B);
    repo.latestTag = "v0.0.1";
    const report = await run(repo);
    expect(report.ok).toBe(false);
    expect(failures(report)).toEqual([
      "stable latest-release: stable clients resolve v0.0.1, expected the highest pipeline-built stable v0.0.2",
      "stable channel-manifest: advertises 0.0.1, expected 0.0.2; points at cw-code-Setup-0.0.1-x64.exe, expected cw-code-Setup-0.0.2-x64.exe"
    ]);
  });

  it("fails when a newer non-pipeline release hides the pipeline release from alpha clients", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    repo.feedOrder.unshift("v0.0.1-beta.1");
    const report = await run(repo);
    expect(failures(report)).toEqual(["alpha atom-feed: alpha clients resolve v0.0.1-beta.1 from the releases feed, expected the highest pipeline-built release v0.0.1-alpha.22"]);
  });

  it("fails on a missing channel manifest", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    repo.urls.delete(`${BASE}/releases/download/v0.0.1-alpha.22/alpha.yml`);
    const report = await run(repo);
    expect(report.channels[1].status).toBe("failed");
    expect(failures(report)).toEqual(["alpha channel-manifest: HTTP 404"]);
  });

  it("fails when alpha.yml and latest.yml of one release differ", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const url = `${BASE}/releases/download/v0.0.1-alpha.22/latest.yml`;
    const stored = repo.urls.get(url);
    if (!stored) throw new Error("fixture has no latest.yml");
    repo.urls.set(url, { status: 200, body: Buffer.concat([stored.body, Buffer.from("releaseDate: '2026-09-25'\n")]) });
    expect(failures(await run(repo))).toEqual(["alpha feed-copy: latest.yml differs from alpha.yml"]);
  });

  it("fails when the served installer size or the listed asset size disagrees with the manifest", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const name = installerNameFor("0.0.1-alpha.22");
    repo.urls.set(`${BASE}/releases/download/v0.0.1-alpha.22/${name}`, { status: 200, body: randomBytes(4000) });
    const asset = repo.listing[0].assets.find((entry) => entry.name === name);
    if (!asset) throw new Error("fixture has no installer asset");
    asset.size = 1;
    expect(failures(await run(repo))).toEqual([
      "alpha installer: served 4000 bytes, the manifest says 4096; release asset is 1 bytes, the manifest says 4096"
    ]);
  });

  it("fails when the installer is gone", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    repo.urls.delete(`${BASE}/releases/download/v0.0.1-alpha.22/${installerNameFor("0.0.1-alpha.22")}`);
    expect(failures(await run(repo))).toEqual(["alpha installer: HTTP 404"]);
  });

  it("fails when the blockmap no longer matches signing.json", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    repo.urls.set(`${BASE}/releases/download/v0.0.1-alpha.22/${installerNameFor("0.0.1-alpha.22")}.blockmap`, { status: 200, body: randomBytes(128) });
    expect(failures(await run(repo))).toEqual(["alpha blockmap: sha512 differs from signing.json"]);
  });

  it("fails on a non-production signing manifest, another source SHA or another installer digest", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const url = `${BASE}/releases/download/v0.0.1-alpha.22/signing.json`;
    const stored = repo.urls.get(url);
    if (!stored) throw new Error("fixture has no signing.json");
    const signing = JSON.parse(stored.body.toString("utf8")) as { production: boolean; sourceSha: string; files: { sha512: string }[] };
    signing.production = false;
    signing.sourceSha = SHA_C;
    signing.files[1].sha512 = digest(Buffer.from("other"));
    repo.urls.set(url, { status: 200, body: Buffer.from(JSON.stringify(signing)) });
    expect(failures(await run(repo))).toEqual([
      `alpha signing: not a production signpath manifest (mode signpath, production false); sourceSha ${SHA_C}, the release marker says ${SHA_A}; records another installer sha512 than alpha.yml`
    ]);
  });

  it("fails on a missing, extra or unfinished asset", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const assets = repo.listing[0].assets;
    repo.listing[0].assets = [...assets.filter((asset) => asset.name !== "signing.json"), { name: "notes.txt", size: 3, state: "starter" }];
    const [problem] = failures(await run(repo));
    expect(problem).toBe("alpha assets: missing assets: signing.json; unexpected assets: notes.txt; not fully uploaded: notes.txt (starter)");
  });

  it("downloads the installer in full only when asked, and then compares its sha512", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const name = installerNameFor("0.0.1-alpha.22");
    const url = `${BASE}/releases/download/v0.0.1-alpha.22/${name}`;
    const stored = repo.urls.get(url);
    if (!stored) throw new Error("fixture has no installer");
    const flipped = Buffer.from(stored.body);
    flipped[10] ^= 0xff;
    repo.urls.set(url, { status: 200, body: flipped });
    expect(failures(await run(repo))).toEqual([]);
    expect(failures(await run(repo, true))).toEqual(["alpha installer-digest: sha512 differs from alpha.yml"]);
  });

  it("fails without channel results when the releases listing cannot be read", async () => {
    const responses = responsesOf(legacyRepo());
    responses.set(LISTING, { status: 403, body: Buffer.from("rate limited") });
    const report = await run(legacyRepo(), false, responses);
    expect(report).toMatchObject({ ok: false, channels: [], summary: "Update feed check FAILED: cannot list releases (HTTP 403)" });
    expect(report.listing.ok).toBe(false);
  });
});

describe("monitorUpdateFeedWithRetries", () => {
  it("retries with exponential backoff only while something fails", async () => {
    const repo = legacyRepo();
    publish(repo, "0.0.1-alpha.22", SHA_A);
    const lagging = responsesOf(repo);
    const fresh = responsesOf(repo);
    const atom = lagging.get(`${BASE}/releases.atom`);
    if (!atom) throw new Error("fixture has no feed");
    lagging.set(`${BASE}/releases.atom`, { status: 200, body: Buffer.from(atom.body.toString("utf8").replace(/<entry>.*?<\/entry>/, "")) });
    const lagHttp = httpFor(lagging);
    const freshHttp = httpFor(fresh);
    let calls = 0;
    const http: FeedMonitorHttp = {
      text: (url, accept) => (calls >= 2 ? freshHttp : lagHttp).text(url, accept),
      digest: (url) => freshHttp.digest(url),
      size: (url) => freshHttp.size(url),
      api: (url) => {
        calls += 1;
        return freshHttp.api(url);
      }
    };
    const sleeps: number[] = [];
    const report = await monitorUpdateFeedWithRetries(
      { owner: "albertofa", repo: "cw-code", http, verifyInstallerDigest: false },
      { attempts: 3, initialDelayMs: 1000, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(report).toMatchObject({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([1000]);
  });

  it("stops after the configured attempts and reports the last result", async () => {
    const responses = responsesOf(legacyRepo());
    responses.set(LISTING, { status: 503, body: Buffer.from("") });
    const sleeps: number[] = [];
    const report = await monitorUpdateFeedWithRetries(
      { owner: "albertofa", repo: "cw-code", http: httpFor(responses), verifyInstallerDigest: false },
      { attempts: 3, initialDelayMs: 500, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(report).toMatchObject({ ok: false, attempts: 3 });
    expect(sleeps).toEqual([500, 1000]);
  });

  it("does not retry a healthy or not-yet-published feed", async () => {
    const sleeps: number[] = [];
    const report = await monitorUpdateFeedWithRetries(
      { owner: "albertofa", repo: "cw-code", http: httpFor(responsesOf(legacyRepo())), verifyInstallerDigest: false },
      { attempts: 3, initialDelayMs: 500, sleep: async (ms) => void sleeps.push(ms) }
    );
    expect(report).toMatchObject({ ok: true, attempts: 1 });
    expect(sleeps).toEqual([]);
  });
});

describe("alphaClientTag", () => {
  const feed = (...tags: string[]) => tags.map((tag) => `<entry><link rel="alternate" href="${BASE}/releases/tag/${tag}"/></entry>`).join("");

  it("takes the first semver entry whose prerelease id is empty, alpha or beta, like electron-updater", () => {
    expect(alphaClientTag(feed("nightly", "v1.0.0-rc.1", "v0.9.0-alpha.3", "v0.8.0"))).toBe("v0.9.0-alpha.3");
    expect(alphaClientTag(feed("v1.0.0", "v0.9.0-alpha.3"))).toBe("v1.0.0");
    expect(alphaClientTag(feed("v1.1.0-beta.1", "v1.0.0"))).toBe("v1.1.0-beta.1");
  });

  it("returns null for an empty or unusable feed", () => {
    expect(alphaClientTag("<feed></feed>")).toBeNull();
    expect(alphaClientTag(feed("latest", "v1.0"))).toBeNull();
  });
});

describe("pipelineReleasesOf", () => {
  it("keeps only published releases with a version tag and the plan marker", () => {
    const listing = [
      { tag_name: "v0.0.1-alpha.22", draft: false, prerelease: true, body: planMarker(SHA_A), assets: [{ name: "a", size: 1, state: "uploaded" }] },
      { tag_name: "v0.0.1-alpha.23", draft: true, prerelease: true, body: planMarker(SHA_B), assets: [] },
      { tag_name: LEGACY, draft: false, prerelease: false, body: "manual", assets: [] },
      { tag_name: "nightly", draft: false, prerelease: true, body: planMarker(SHA_C), assets: [] }
    ];
    expect(pipelineReleasesOf(JSON.stringify(listing))?.map((release) => [release.tag, release.sourceSha, release.assets.length])).toEqual([["v0.0.1-alpha.22", SHA_A, 1]]);
    expect(pipelineReleasesOf("{}")).toBeNull();
    expect(pipelineReleasesOf("not json")).toBeNull();
  });
});
