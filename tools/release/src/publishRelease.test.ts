import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planMarker, releaseBody } from "./planMarker.ts";
import type { ReleasePlan } from "./planValidation.ts";
import { publishRelease } from "./publishRelease.ts";
import { type ReleaseAssetFile, isFeedManifest, publishableAssetNames } from "./releaseAssets.ts";
import type { CreateDraftInput, GitHubReleaseClient, PublishFlags, RemoteAsset, RemoteRelease } from "./releaseClient.ts";
import type { ReleaseInfo, ReleaseSource } from "./releaseSource.ts";

const SOURCE_SHA = "c".repeat(40);
const OLDER_SHA = "b".repeat(40);

const ALPHA_PLAN: ReleasePlan = {
  schema: 1,
  channel: "alpha",
  version: "1.2.0-alpha.3",
  tag: "v1.2.0-alpha.3",
  sourceSha: SOURCE_SHA,
  previousTag: "v1.2.0-alpha.2",
  prerelease: true,
  makeLatest: false,
  notes: "## Fixes\n\n- fix: something",
  createdAt: "2026-09-25T06:00:00.000Z"
};

const STABLE_PLAN: ReleasePlan = {
  ...ALPHA_PLAN,
  channel: "stable",
  version: "1.2.0",
  tag: "v1.2.0",
  candidate: { tag: "v1.2.0-alpha.2", sha: SOURCE_SHA },
  previousTag: null,
  prerelease: false,
  makeLatest: true
};

interface FakeAsset extends RemoteAsset {
  bytes: Buffer;
}

interface FakeRelease extends Omit<RemoteRelease, "assets"> {
  assets: FakeAsset[];
  makeLatest: boolean | null;
}

function digest(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

class FakeGitHub implements GitHubReleaseClient {
  releases: FakeRelease[] = [];
  tags = new Map<string, string>();
  isPublic = true;
  calls: string[] = [];
  failNextUpload: string | null = null;
  corruptDownloadsOf: string | null = null;
  private nextId = 100;

  addPublished(tag: string, sha: string, prerelease: boolean, assets: Array<{ name: string; bytes: Buffer }> = [], body = ""): FakeRelease {
    const release = this.release({ tagName: tag, targetCommitish: sha, draft: false, prerelease, body, assets });
    this.tags.set(tag, sha);
    return release;
  }

  release(fields: { tagName: string; targetCommitish: string; draft: boolean; prerelease: boolean; body: string; assets: Array<{ name: string; bytes: Buffer; state?: string }> }): FakeRelease {
    const id = this.nextId++;
    const release: FakeRelease = {
      id,
      tagName: fields.tagName,
      targetCommitish: fields.targetCommitish,
      draft: fields.draft,
      prerelease: fields.prerelease,
      name: fields.tagName,
      body: fields.body,
      htmlUrl: `https://github.com/albertofa/cw-code/releases/tag/${fields.tagName}`,
      makeLatest: null,
      assets: fields.assets.map((asset) => ({ id: this.nextId++, name: asset.name, size: asset.bytes.length, state: asset.state ?? "uploaded", bytes: asset.bytes }))
    };
    this.releases.push(release);
    return release;
  }

  private view(release: FakeRelease): RemoteRelease {
    return { ...release, assets: release.assets.map(({ id, name, size, state }) => ({ id, name, size, state })) };
  }

  private find(id: number): FakeRelease {
    const release = this.releases.find((entry) => entry.id === id);
    if (!release) throw new Error(`no release ${id}`);
    return release;
  }

  async repositoryIsPublic(): Promise<boolean> {
    return this.isPublic;
  }

  async listReleases(): Promise<RemoteRelease[]> {
    return this.releases.map((release) => this.view(release));
  }

  async createDraft(input: CreateDraftInput): Promise<RemoteRelease> {
    this.calls.push(`create ${input.tag}`);
    return this.view(this.release({ tagName: input.tag, targetCommitish: input.targetSha, draft: true, prerelease: input.prerelease, body: input.body, assets: [] }));
  }

  async updateDraft(releaseId: number, fields: { name: string; body: string; prerelease: boolean }): Promise<void> {
    this.calls.push(`update ${releaseId}`);
    Object.assign(this.find(releaseId), fields);
  }

  async getRelease(releaseId: number): Promise<RemoteRelease> {
    return this.view(this.find(releaseId));
  }

  async uploadAsset(release: RemoteRelease, path: string, name: string): Promise<void> {
    const target = this.find(release.id);
    if (target.assets.some((asset) => asset.name === name)) throw new Error(`asset ${name} already exists`);
    const bytes = await readFile(path);
    if (this.failNextUpload === name) {
      this.failNextUpload = null;
      target.assets.push({ id: this.nextId++, name, size: 0, state: "starter", bytes: Buffer.alloc(0) });
      throw new Error(`upload of ${name} interrupted`);
    }
    this.calls.push(`upload ${name}`);
    target.assets.push({ id: this.nextId++, name, size: bytes.length, state: "uploaded", bytes });
  }

  async deleteAsset(assetId: number): Promise<void> {
    for (const release of this.releases) {
      const asset = release.assets.find((entry) => entry.id === assetId);
      if (!asset) continue;
      if (!release.draft) throw new Error("the fake refuses to delete assets of a published release");
      this.calls.push(`delete ${asset.name}`);
      release.assets = release.assets.filter((entry) => entry.id !== assetId);
      return;
    }
    throw new Error(`no asset ${assetId}`);
  }

  async downloadAsset(release: RemoteRelease, asset: RemoteAsset, destinationDir: string): Promise<string> {
    const stored = this.find(release.id).assets.find((entry) => entry.id === asset.id);
    if (!stored) throw new Error(`no asset ${asset.name}`);
    const bytes = this.corruptDownloadsOf === asset.name ? Buffer.concat([stored.bytes.subarray(1), Buffer.from([0])]) : stored.bytes;
    const path = join(destinationDir, asset.name);
    await writeFile(path, bytes);
    return path;
  }

  async publish(releaseId: number, flags: PublishFlags): Promise<RemoteRelease> {
    const release = this.find(releaseId);
    this.calls.push(`publish ${release.tagName} prerelease=${flags.prerelease} latest=${flags.makeLatest}`);
    release.draft = false;
    release.prerelease = flags.prerelease;
    release.makeLatest = flags.makeLatest;
    if (!this.tags.has(release.tagName)) this.tags.set(release.tagName, release.targetCommitish);
    return this.view(release);
  }

  async remoteTagSha(tag: string): Promise<string | null> {
    return this.tags.get(tag) ?? null;
  }
}

function sourceFor(github: FakeGitHub, onList?: (call: number) => void): ReleaseSource {
  let calls = 0;
  const unused = (): never => {
    throw new Error("not used by publishRelease");
  };
  return {
    async listReleases(): Promise<ReleaseInfo[]> {
      calls += 1;
      onList?.(calls);
      return github.releases.map((release) => ({
        tagName: release.tagName,
        targetCommitish: release.targetCommitish,
        draft: release.draft,
        prerelease: release.prerelease,
        publishedAt: release.draft ? "" : "2026-09-24T00:00:00Z",
        htmlUrl: release.htmlUrl,
        name: release.name,
        body: release.body
      }));
    },
    tagSha: async (tag) => github.tags.get(tag) ?? null,
    headSha: unused,
    isAncestorOfMain: async (sha) => sha === SOURCE_SHA || sha === OLDER_SHA,
    logSubjects: unused,
    showFile: unused
  };
}

describe("publishRelease", () => {
  let root: string;
  let github: FakeGitHub;

  async function writeSet(plan: ReleasePlan, name: string): Promise<{ dir: string; assets: ReleaseAssetFile[] }> {
    const dir = join(root, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const assets: ReleaseAssetFile[] = [];
    const feedBytes = randomBytes(64);
    for (const assetName of publishableAssetNames(plan)) {
      const bytes = isFeedManifest(assetName) ? feedBytes : randomBytes(assetName.endsWith(".exe") ? 2048 : 128);
      await writeFile(join(dir, assetName), bytes);
      assets.push({ name: assetName, size: bytes.length, sha512: digest(bytes) });
    }
    return { dir, assets };
  }

  function run(plan: ReleasePlan, set: { dir: string; assets: ReleaseAssetFile[] }, source = sourceFor(github)) {
    return publishRelease({ plan, dir: set.dir, assets: set.assets, client: github, source, workDir: join(root, "work") });
  }

  function draftOf(tag: string): FakeRelease | undefined {
    return github.releases.find((release) => release.tagName === tag);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-publish-"));
    github = new FakeGitHub();
    github.addPublished("v1.2.0-alpha.2", OLDER_SHA, true);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a marked draft at the source SHA, uploads feeds last, verifies and publishes an alpha as a non-latest prerelease", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    const result = await run(ALPHA_PLAN, set);
    expect(result).toMatchObject({ status: "published", resumed: false, uploaded: publishableAssetNames(ALPHA_PLAN), reused: [], replaced: [] });
    expect(github.calls).toEqual([
      "create v1.2.0-alpha.3",
      ...publishableAssetNames(ALPHA_PLAN).map((name) => `upload ${name}`),
      "publish v1.2.0-alpha.3 prerelease=true latest=false"
    ]);
    const release = draftOf(ALPHA_PLAN.tag);
    expect(release).toMatchObject({ draft: false, prerelease: true, makeLatest: false, targetCommitish: SOURCE_SHA, body: releaseBody(ALPHA_PLAN.notes, SOURCE_SHA) });
    expect(release?.body).toContain(planMarker(SOURCE_SHA));
    expect(github.tags.get(ALPHA_PLAN.tag)).toBe(SOURCE_SHA);
  });

  it("publishes a stable release as latest and not prerelease, with latest.yml uploaded last", async () => {
    github.tags.set("v1.2.0-alpha.2", SOURCE_SHA);
    const set = await writeSet(STABLE_PLAN, "set");
    await run(STABLE_PLAN, set);
    expect(github.calls.filter((call) => call.startsWith("upload")).at(-1)).toBe("upload latest.yml");
    expect(github.calls.at(-1)).toBe("publish v1.2.0 prerelease=false latest=true");
    expect(draftOf("v1.2.0")).toMatchObject({ draft: false, prerelease: false, makeLatest: true });
  });

  it("recovers from an interrupted upload on rerun without ever holding a feed file that points at missing bytes", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    github.failNextUpload = "signing.json";
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/upload of signing.json interrupted/);
    const draft = draftOf(ALPHA_PLAN.tag);
    expect(draft?.draft).toBe(true);
    expect(draft?.assets.map((asset) => asset.name).filter(isFeedManifest)).toEqual([]);
    expect(github.tags.has(ALPHA_PLAN.tag)).toBe(false);

    github.calls = [];
    const result = await run(ALPHA_PLAN, set);
    expect(result).toMatchObject({ status: "published", resumed: true });
    expect(result.reused).toEqual(publishableAssetNames(ALPHA_PLAN).slice(0, 2));
    expect(github.calls).toEqual(["delete signing.json", "upload signing.json", "upload latest.yml", "upload alpha.yml", "publish v1.2.0-alpha.3 prerelease=true latest=false"]);
  });

  it("resumes a draft from a full rerun with re-signed bytes, pulling feed files before replacing the payload", async () => {
    const first = await writeSet(ALPHA_PLAN, "first");
    github.release({
      tagName: ALPHA_PLAN.tag,
      targetCommitish: SOURCE_SHA,
      draft: true,
      prerelease: true,
      body: releaseBody(ALPHA_PLAN.notes, SOURCE_SHA),
      assets: await Promise.all(first.assets.map(async (asset) => ({ name: asset.name, bytes: await readFile(join(first.dir, asset.name)) })))
    });
    const second = await writeSet(ALPHA_PLAN, "second");
    const result = await run(ALPHA_PLAN, second);
    expect(result).toMatchObject({ status: "published", resumed: true, reused: [] });
    const deletes = github.calls.filter((call) => call.startsWith("delete"));
    expect(deletes.slice(0, 2)).toEqual(["delete latest.yml", "delete alpha.yml"]);
    const release = draftOf(ALPHA_PLAN.tag);
    for (const asset of second.assets) expect(digest(release?.assets.find((entry) => entry.name === asset.name)?.bytes ?? Buffer.alloc(0))).toBe(asset.sha512);
  });

  it("reuses a draft that already holds identical bytes and only publishes it", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    github.release({
      tagName: ALPHA_PLAN.tag,
      targetCommitish: SOURCE_SHA,
      draft: true,
      prerelease: true,
      body: releaseBody(ALPHA_PLAN.notes, SOURCE_SHA),
      assets: await Promise.all(set.assets.map(async (asset) => ({ name: asset.name, bytes: await readFile(join(set.dir, asset.name)) })))
    });
    const result = await run(ALPHA_PLAN, set);
    expect(result).toMatchObject({ status: "published", resumed: true, uploaded: [], replaced: [] });
    expect(github.calls).toEqual(["publish v1.2.0-alpha.3 prerelease=true latest=false"]);
  });

  it("rejects drafts it does not own and existing tags without touching anything", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    github.release({ tagName: ALPHA_PLAN.tag, targetCommitish: SOURCE_SHA, draft: true, prerelease: true, body: "hand-made draft", assets: [] });
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/cannot resume/);
    github.releases = github.releases.filter((release) => release.tagName !== ALPHA_PLAN.tag);
    github.release({ tagName: ALPHA_PLAN.tag, targetCommitish: OLDER_SHA, draft: true, prerelease: true, body: planMarker(OLDER_SHA), assets: [] });
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/cannot resume/);
    github.releases = github.releases.filter((release) => release.tagName !== ALPHA_PLAN.tag);
    github.tags.set(ALPHA_PLAN.tag, OLDER_SHA);
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/already exists in git/);
    expect(github.calls).toEqual([]);
  });

  it("refuses a draft carrying assets outside the release set", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    github.release({ tagName: ALPHA_PLAN.tag, targetCommitish: SOURCE_SHA, draft: true, prerelease: true, body: planMarker(SOURCE_SHA), assets: [{ name: "notes.txt", bytes: Buffer.from("x") }] });
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/does not own \(notes.txt\)/);
    expect(github.calls.filter((call) => !call.startsWith("update"))).toEqual([]);
  });

  it("never overwrites a published release with different bytes, and accepts an identical one as already published", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    const published = github.addPublished(
      ALPHA_PLAN.tag,
      SOURCE_SHA,
      true,
      await Promise.all(set.assets.map(async (asset) => ({ name: asset.name, bytes: await readFile(join(set.dir, asset.name)) }))),
      releaseBody(ALPHA_PLAN.notes, SOURCE_SHA)
    );
    expect(await run(ALPHA_PLAN, set)).toMatchObject({ status: "already-published", releaseId: published.id });
    const other = await writeSet(ALPHA_PLAN, "other");
    await expect(run(ALPHA_PLAN, other)).rejects.toThrow(/already published and differs .* never overwritten/s);
    expect(github.calls).toEqual([]);
  });

  it("re-checks version ordering after uploading and leaves the draft unpublished when a higher alpha appeared", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    const source = sourceFor(github, (call) => {
      if (call === 2) github.addPublished("v1.2.0-alpha.4", SOURCE_SHA, true);
    });
    await expect(run(ALPHA_PLAN, set, source)).rejects.toThrow(/higher or equal alpha version \(1.2.0-alpha.4\)/);
    expect(draftOf(ALPHA_PLAN.tag)?.draft).toBe(true);
    expect(github.calls.some((call) => call.startsWith("publish"))).toBe(false);
  });

  it("does not publish when re-downloaded bytes differ from the validated set", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    github.corruptDownloadsOf = basename(set.assets[0].name);
    await expect(run(ALPHA_PLAN, set)).rejects.toThrow(/downloaded bytes differ/);
    expect(draftOf(ALPHA_PLAN.tag)?.draft).toBe(true);
  });

  it("refuses to publish from a private repository", async () => {
    github.isPublic = false;
    await expect(run(ALPHA_PLAN, await writeSet(ALPHA_PLAN, "set"))).rejects.toThrow(/not public/);
    expect(github.calls).toEqual([]);
  });

  it("fails loudly when the published tag does not point at the source SHA", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    const source = sourceFor(github);
    const publish = github.publish.bind(github);
    github.publish = async (releaseId, flags) => {
      github.tags.set(ALPHA_PLAN.tag, OLDER_SHA);
      return publish(releaseId, flags);
    };
    await expect(run(ALPHA_PLAN, set, source)).rejects.toThrow(/public but inconsistent[\s\S]*points at b{40}/);
  });

  it("keeps working files out of the release set directory", async () => {
    const set = await writeSet(ALPHA_PLAN, "set");
    await run(ALPHA_PLAN, set);
    expect((await readdir(set.dir)).sort()).toEqual([...publishableAssetNames(ALPHA_PLAN)].sort());
  });
});
