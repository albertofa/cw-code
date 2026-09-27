import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhError, createGitHubReleaseClient } from "./gitHubReleaseClient.ts";
import type { RemoteRelease } from "./releaseClient.ts";

const RAW = {
  id: 7,
  tag_name: "v1.2.0-alpha.3",
  target_commitish: "c".repeat(40),
  draft: true,
  prerelease: true,
  name: "v1.2.0-alpha.3",
  body: null,
  html_url: "https://github.com/albertofa/cw-code/releases/tag/untagged-1",
  assets: [{ id: 9, name: "latest.yml", size: 10, state: "uploaded" }]
};

const RELEASE: RemoteRelease = {
  id: 7,
  tagName: "v1.2.0-alpha.3",
  targetCommitish: "c".repeat(40),
  draft: true,
  prerelease: true,
  name: "v1.2.0-alpha.3",
  body: "",
  htmlUrl: RAW.html_url,
  assets: [{ id: 9, name: "latest.yml", size: 10, state: "uploaded" }]
};

interface Call {
  args: string[];
  bodyFile: string | null;
}

describe("createGitHubReleaseClient", () => {
  let calls: Call[];
  let replies: Array<string | ((args: string[]) => Promise<string>)>;
  let dir: string;

  const client = () =>
    createGitHubReleaseClient("albertofa", "cw-code", async (args) => {
      const bodyArg = args.find((arg) => arg.startsWith("body=@"));
      calls.push({ args, bodyFile: bodyArg ? await readFile(bodyArg.slice("body=@".length), "utf8") : null });
      const reply = replies.shift() ?? "";
      return typeof reply === "string" ? reply : reply(args);
    });

  beforeEach(async () => {
    calls = [];
    replies = [];
    dir = await mkdtemp(join(tmpdir(), "cw-gh-client-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a draft at the source SHA with the body passed through a file, never on the command line", async () => {
    replies.push(JSON.stringify(RAW));
    const release = await client().createDraft({ tag: "v1.2.0-alpha.3", targetSha: "c".repeat(40), name: "v1.2.0-alpha.3", body: "notes; $(rm -rf /)", prerelease: true });
    expect(release).toEqual(RELEASE);
    const [call] = calls;
    expect(call.args.slice(0, 4)).toEqual(["api", "repos/albertofa/cw-code/releases", "--method", "POST"]);
    expect(call.args).toContain(`target_commitish=${"c".repeat(40)}`);
    expect(call.args).toContain("draft=true");
    expect(call.args).toContain("prerelease=true");
    expect(call.args.join(" ")).not.toContain("rm -rf");
    expect(call.bodyFile).toBe("notes; $(rm -rf /)");
  });

  it("publishes with draft=false, the prerelease flag and make_latest as a string", async () => {
    replies.push(JSON.stringify({ ...RAW, draft: false }));
    await client().publish(7, { prerelease: false, makeLatest: true });
    expect(calls[0].args).toEqual(expect.arrayContaining(["repos/albertofa/cw-code/releases/7", "PATCH", "draft=false", "prerelease=false", "make_latest=true"]));
    expect(calls[0].args[calls[0].args.indexOf("make_latest=true") - 1]).toBe("-f");
  });

  it("keeps drafts as drafts when updating them", async () => {
    await client().updateDraft(7, { name: "v1.2.0-alpha.3", body: "new notes", prerelease: true });
    expect(calls[0].args).toEqual(expect.arrayContaining(["repos/albertofa/cw-code/releases/7", "PATCH", "draft=true", "prerelease=true"]));
    expect(calls[0].bodyFile).toBe("new notes");
  });

  it("uploads without --clobber and deletes assets by id", async () => {
    await client().uploadAsset(RELEASE, join(dir, "latest.yml"), "latest.yml");
    await client().deleteAsset(9);
    expect(calls[0].args).toEqual(["release", "upload", "v1.2.0-alpha.3", join(dir, "latest.yml"), "--repo", "albertofa/cw-code"]);
    expect(calls[1].args).toEqual(["api", "repos/albertofa/cw-code/releases/assets/9", "--method", "DELETE"]);
  });

  it("downloads exactly the requested asset and fails if gh wrote anything else", async () => {
    replies.push(async (args) => {
      await writeFile(join(args[args.indexOf("--dir") + 1], "latest.yml"), "x");
      return "";
    });
    expect(await client().downloadAsset(RELEASE, RELEASE.assets[0], dir)).toBe(join(dir, "latest.yml"));
    expect(calls[0].args).toEqual(["release", "download", "v1.2.0-alpha.3", "--repo", "albertofa/cw-code", "--pattern", "latest.yml", "--dir", dir]);

    const other = await mkdtemp(join(tmpdir(), "cw-gh-client-other-"));
    replies.push(async (args) => {
      await writeFile(join(args[args.indexOf("--dir") + 1], "alpha.yml"), "x");
      return "";
    });
    await expect(client().downloadAsset(RELEASE, RELEASE.assets[0], other)).rejects.toThrow(/instead of exactly that asset/);
    await rm(other, { recursive: true, force: true });
  });

  it("lists every release across pages, one JSON object per line", async () => {
    replies.push(`${JSON.stringify(RAW)}\n${JSON.stringify({ ...RAW, id: 8, draft: false })}\n`);
    const releases = await client().listReleases();
    expect(releases.map((release) => [release.id, release.draft])).toEqual([[7, true], [8, false]]);
    expect(calls[0].args).toEqual(expect.arrayContaining(["repos/albertofa/cw-code/releases?per_page=100", "--paginate"]));
  });

  it("resolves lightweight and annotated tags and treats 404 as no tag", async () => {
    replies.push(`commit ${"c".repeat(40)}\n`);
    expect(await client().remoteTagSha("v1.2.0")).toBe("c".repeat(40));
    replies.push(`tag ${"d".repeat(40)}\n`, `${"e".repeat(40)}\n`);
    expect(await client().remoteTagSha("v1.2.0")).toBe("e".repeat(40));
    expect(calls.at(-1)?.args[1]).toBe(`repos/albertofa/cw-code/git/tags/${"d".repeat(40)}`);
    replies.push(async (args) => {
      throw new GhError(args, "gh: Not Found (HTTP 404)");
    });
    expect(await client().remoteTagSha("v9.9.9")).toBeNull();
    replies.push(async (args) => {
      throw new GhError(args, "gh: Bad credentials (HTTP 401)");
    });
    await expect(client().remoteTagSha("v9.9.9")).rejects.toThrow(/HTTP 401/);
  });

  it("reads the repository visibility", async () => {
    replies.push("public\n", "private\n");
    expect(await client().repositoryIsPublic()).toBe(true);
    expect(await client().repositoryIsPublic()).toBe(false);
    expect(calls[0].args).toEqual(["api", "repos/albertofa/cw-code", "--jq", ".visibility"]);
  });
});
