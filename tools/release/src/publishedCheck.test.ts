import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReleasePlan } from "./planValidation.ts";
import { type AnonymousHttp, checkPublishedRelease, checkPublishedReleaseWithRetries } from "./publishedCheck.ts";
import { installerNameFor, publishableAssetNames } from "./releaseAssets.ts";

const SOURCE_SHA = "c".repeat(40);
const BASE = "https://github.com/albertofa/cw-code";

const ALPHA: ReleasePlan = {
  schema: 1,
  channel: "alpha",
  version: "1.2.0-alpha.3",
  tag: "v1.2.0-alpha.3",
  sourceSha: SOURCE_SHA,
  previousTag: null,
  prerelease: true,
  makeLatest: false,
  notes: "",
  createdAt: "2026-09-25T06:00:00.000Z"
};

const STABLE: ReleasePlan = { ...ALPHA, channel: "stable", version: "1.2.0", tag: "v1.2.0", candidate: { tag: "v1.2.0-alpha.3", sha: SOURCE_SHA }, prerelease: false, makeLatest: true };

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

type Responses = Map<string, { status: number; body: Buffer }>;

function published(plan: ReleasePlan, latestTag: string | null): Responses {
  const installer = randomBytes(2048);
  const blockMap = randomBytes(64);
  const name = installerNameFor(plan.version);
  const feed = `version: ${plan.version}\nfiles:\n  - url: ${name}\n    sha512: ${digest(installer)}\n    size: ${installer.length}\npath: ${name}\nsha512: ${digest(installer)}\nreleaseName: ${plan.tag}\nreleaseNotes: notes\n`;
  const signed = { status: "Valid", signed: true, subject: "CN=SignPath Foundation", timestamped: true };
  const signing = {
    mode: "signpath",
    production: true,
    publisher: "SignPath Foundation",
    version: plan.version,
    sourceSha: plan.sourceSha,
    runId: "1",
    verifiedAt: "2026-09-25T06:30:00.000Z",
    files: [
      { path: "win-unpacked/cw-code.exe", role: "first-party", sha512: digest(Buffer.from("app")), ...signed },
      { path: name, role: "first-party", sha512: digest(installer), ...signed }
    ],
    blockMap: { path: `${name}.blockmap`, sha512: digest(blockMap), size: blockMap.length }
  };
  const download = `${BASE}/releases/download/${plan.tag}`;
  const json = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
  const responses: Responses = new Map([
    [`https://api.github.com/repos/albertofa/cw-code/releases/tags/${plan.tag}`, json({ draft: false, prerelease: plan.prerelease, assets: publishableAssetNames(plan).map((asset) => ({ name: asset })) })],
    [`${BASE}/releases/latest`, latestTag ? json({ tag_name: latestTag }) : { status: 404, body: Buffer.from("Not Found") }],
    [`${BASE}/releases.atom`, { status: 200, body: Buffer.from(`<feed><entry><link href="${BASE}/releases/tag/${plan.tag}"/></entry></feed>`) }],
    [`${download}/${name}`, { status: 200, body: installer }],
    [`${download}/${name}.blockmap`, { status: 200, body: blockMap }],
    [`${download}/signing.json`, json(signing)],
    [`${download}/alpha.yml`, { status: 200, body: Buffer.from(feed) }],
    [`${download}/latest.yml`, { status: 200, body: Buffer.from(feed) }]
  ]);
  if (latestTag === plan.tag) responses.set(`${BASE}/releases/latest/download/latest.yml`, { status: 200, body: Buffer.from(feed) });
  return responses;
}

function httpFor(responses: Responses, seen: string[] = []): AnonymousHttp {
  const get = (url: string) => {
    seen.push(url);
    return responses.get(url) ?? { status: 404, body: Buffer.from("Not Found") };
  };
  return {
    async text(url) {
      const response = get(url);
      return { status: response.status, body: response.body.toString("utf8") };
    },
    async digest(url) {
      const response = get(url);
      return { status: response.status, sha512: digest(response.body), size: response.body.length };
    }
  };
}

function failures(checks: Awaited<ReturnType<typeof checkPublishedRelease>>): string[] {
  return checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`);
}

describe("checkPublishedRelease", () => {
  it("passes an alpha that is public, listed, not latest, and whose alpha.yml, installer and blockmap match", async () => {
    const seen: string[] = [];
    const checks = await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(published(ALPHA, "v1.1.0"), seen) });
    expect(failures(checks)).toEqual([]);
    expect(seen).toContain(`${BASE}/releases/download/${ALPHA.tag}/alpha.yml`);
  });

  it("passes a stable release through the /releases/latest/download/latest.yml URL clients use", async () => {
    const seen: string[] = [];
    const checks = await checkPublishedRelease({ plan: STABLE, owner: "albertofa", repo: "cw-code", http: httpFor(published(STABLE, "v1.2.0"), seen) });
    expect(failures(checks)).toEqual([]);
    expect(seen).toContain(`${BASE}/releases/latest/download/latest.yml`);
  });

  it("fails when an alpha became the latest release or a stable one did not", async () => {
    expect(failures(await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(published(ALPHA, ALPHA.tag)) })).join()).toMatch(
      /latest-release: alpha v1.2.0-alpha.3 is marked as the latest release/
    );
    const stable = published(STABLE, "v1.1.0");
    expect(failures(await checkPublishedRelease({ plan: STABLE, owner: "albertofa", repo: "cw-code", http: httpFor(stable) })).join()).toMatch(
      /latest-release: stable clients resolve the latest release to v1.1.0/
    );
  });

  it("fails on corrupted or unreachable bytes, a wrong manifest version, missing assets and a non-production manifest", async () => {
    const responses = published(ALPHA, null);
    const download = `${BASE}/releases/download/${ALPHA.tag}`;
    responses.set(`${download}/${installerNameFor(ALPHA.version)}`, { status: 200, body: randomBytes(2048) });
    responses.delete(`${download}/${installerNameFor(ALPHA.version)}.blockmap`);
    const api = `https://api.github.com/repos/albertofa/cw-code/releases/tags/${ALPHA.tag}`;
    responses.set(api, { status: 200, body: Buffer.from(JSON.stringify({ draft: false, prerelease: true, assets: [{ name: "alpha.yml" }, { name: "extra.zip" }] })) });
    const text = failures(await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(responses) })).join("\n");
    expect(text).toMatch(/installer: sha512 differs/);
    expect(text).toMatch(/blockmap: HTTP 404/);
    expect(text).toMatch(/release: missing assets: .*unexpected assets: extra.zip/);

    const other = published(ALPHA, null);
    other.set(`${download}/alpha.yml`, { status: 200, body: Buffer.from(other.get(`${download}/alpha.yml`)?.body.toString("utf8").replaceAll("1.2.0-alpha.3", "1.2.0-alpha.2") ?? "") });
    const signing = JSON.parse(other.get(`${download}/signing.json`)?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    other.set(`${download}/signing.json`, { status: 200, body: Buffer.from(JSON.stringify({ ...signing, mode: "unsigned", production: false, publisher: null })) });
    const second = failures(await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(other) })).join("\n");
    expect(second).toMatch(/channel-manifest: advertises 1.2.0-alpha.2/);
    expect(second).toMatch(/releaseName is "v1.2.0-alpha.2", so clients would show another release's title/);
    expect(second).toMatch(/signing: not a production signpath manifest/);
  });

  it("retries until the CDN catches up and reports the attempt count", async () => {
    const responses = published(ALPHA, null);
    const atom = responses.get(`${BASE}/releases.atom`);
    responses.set(`${BASE}/releases.atom`, { status: 200, body: Buffer.from("<feed></feed>") });
    responses.set("https://api.github.com/repos/albertofa/cw-code/releases?per_page=1", { status: 200, body: Buffer.from(JSON.stringify([{ tag_name: ALPHA.tag }])) });
    const sleeps: number[] = [];
    const report = await checkPublishedReleaseWithRetries(
      { plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(responses) },
      {
        attempts: 3,
        delayMs: 5,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (atom) responses.set(`${BASE}/releases.atom`, atom);
        }
      }
    );
    expect(report).toMatchObject({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([5]);
  });

  it("only requires the tag in the Atom feed while the release is within the feed's window", async () => {
    const responses = published(ALPHA, null);
    const newer = Array.from({ length: 10 }, (_, index) => `v1.2.0-alpha.${20 + index}`);
    responses.set(`${BASE}/releases.atom`, { status: 200, body: Buffer.from(newer.map((tag) => `<link href="${BASE}/releases/tag/${tag}"/>`).join("")) });
    const recentUrl = "https://api.github.com/repos/albertofa/cw-code/releases?per_page=10";
    responses.set(recentUrl, { status: 200, body: Buffer.from(JSON.stringify(newer.map((tag) => ({ tag_name: tag })))) });
    const outside = await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(responses) });
    expect(failures(outside)).toEqual([]);
    expect(outside.find((entry) => entry.name === "atom-feed")?.detail).toMatch(/older than the 10 releases the feed lists/);

    responses.set(recentUrl, { status: 200, body: Buffer.from(JSON.stringify([{ tag_name: ALPHA.tag }, ...newer.slice(1).map((tag) => ({ tag_name: tag }))])) });
    const inside = await checkPublishedRelease({ plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(responses) });
    expect(failures(inside).join()).toMatch(/atom-feed: v1.2.0-alpha.3 is among the 10 most recent releases but not in the feed yet/);
  });

  it("gives up after the last attempt with the failing checks", async () => {
    const responses = published(ALPHA, null);
    responses.delete(`${BASE}/releases/download/${ALPHA.tag}/alpha.yml`);
    const report = await checkPublishedReleaseWithRetries(
      { plan: ALPHA, owner: "albertofa", repo: "cw-code", http: httpFor(responses) },
      { attempts: 2, delayMs: 0, sleep: async () => undefined }
    );
    expect(report.ok).toBe(false);
    expect(report.attempts).toBe(2);
    expect(failures(report.checks).join()).toMatch(/channel-manifest: HTTP 404/);
  });
});
