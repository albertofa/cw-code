import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CreateDraftInput, GitHubReleaseClient, PublishFlags, RemoteAsset, RemoteRelease } from "./releaseClient.ts";

const execFileAsync = promisify(execFile);

const RELEASE_PROJECTION =
  "{id, tag_name, target_commitish, draft, prerelease, name, body, html_url, assets: [.assets[] | {id, name, size, state}]}";

interface RawRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  name: string | null;
  body: string | null;
  html_url: string;
  assets: RemoteAsset[];
}

export type GhRunner = (args: string[]) => Promise<string>;

export class GhError extends Error {
  readonly notFound: boolean;

  constructor(args: string[], stderr: string) {
    super(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || "no output"}`);
    this.notFound = /HTTP 404/.test(stderr);
  }
}

export const runGh: GhRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : String(error);
    throw new GhError(args, stderr);
  }
};

function toRelease(raw: RawRelease): RemoteRelease {
  return {
    id: raw.id,
    tagName: raw.tag_name,
    targetCommitish: raw.target_commitish,
    draft: raw.draft,
    prerelease: raw.prerelease,
    name: raw.name ?? "",
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    assets: raw.assets.map(({ id, name, size, state }) => ({ id, name, size, state }))
  };
}

function parseRelease(stdout: string): RemoteRelease {
  return toRelease(JSON.parse(stdout) as RawRelease);
}

export function createGitHubReleaseClient(owner: string, repo: string, gh: GhRunner = runGh): GitHubReleaseClient {
  const slug = `${owner}/${repo}`;
  const api = `repos/${slug}`;

  async function withBodyFile<T>(body: string, action: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "cw-release-body-"));
    try {
      const path = join(dir, "body.md");
      await writeFile(path, body, "utf8");
      return await action(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    async repositoryIsPublic(): Promise<boolean> {
      return (await gh(["api", api, "--jq", ".visibility"])).trim() === "public";
    },

    async listReleases(): Promise<RemoteRelease[]> {
      const stdout = await gh(["api", `${api}/releases?per_page=100`, "--paginate", "--jq", `.[] | ${RELEASE_PROJECTION}`]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(parseRelease);
    },

    async createDraft(input: CreateDraftInput): Promise<RemoteRelease> {
      return withBodyFile(input.body, async (bodyPath) =>
        parseRelease(
          await gh([
            "api", `${api}/releases`, "--method", "POST",
            "-f", `tag_name=${input.tag}`,
            "-f", `target_commitish=${input.targetSha}`,
            "-f", `name=${input.name}`,
            "-F", `body=@${bodyPath}`,
            "-F", "draft=true",
            "-F", `prerelease=${input.prerelease}`,
            "--jq", RELEASE_PROJECTION
          ])
        )
      );
    },

    async updateDraft(releaseId: number, fields: { name: string; body: string; prerelease: boolean }): Promise<void> {
      await withBodyFile(fields.body, (bodyPath) =>
        gh(["api", `${api}/releases/${releaseId}`, "--method", "PATCH", "-f", `name=${fields.name}`, "-F", `body=@${bodyPath}`, "-F", `prerelease=${fields.prerelease}`, "-F", "draft=true"])
      );
    },

    async getRelease(releaseId: number): Promise<RemoteRelease> {
      return parseRelease(await gh(["api", `${api}/releases/${releaseId}`, "--jq", RELEASE_PROJECTION]));
    },

    async uploadAsset(release: RemoteRelease, path: string): Promise<void> {
      await gh(["release", "upload", release.tagName, path, "--repo", slug]);
    },

    async deleteAsset(assetId: number): Promise<void> {
      await gh(["api", `${api}/releases/assets/${assetId}`, "--method", "DELETE"]);
    },

    async downloadAsset(release: RemoteRelease, asset: RemoteAsset, destinationDir: string): Promise<string> {
      await gh(["release", "download", release.tagName, "--repo", slug, "--pattern", asset.name, "--dir", destinationDir]);
      const files = await readdir(destinationDir);
      if (files.length !== 1 || files[0] !== asset.name) {
        throw new Error(`gh release download ${asset.name} wrote ${JSON.stringify(files)} instead of exactly that asset`);
      }
      return join(destinationDir, asset.name);
    },

    async publish(releaseId: number, flags: PublishFlags): Promise<RemoteRelease> {
      return parseRelease(
        await gh([
          "api", `${api}/releases/${releaseId}`, "--method", "PATCH",
          "-F", "draft=false",
          "-F", `prerelease=${flags.prerelease}`,
          "-f", `make_latest=${flags.makeLatest}`,
          "--jq", RELEASE_PROJECTION
        ])
      );
    },

    async remoteTagSha(tag: string): Promise<string | null> {
      let ref: string;
      try {
        ref = (await gh(["api", `${api}/git/ref/tags/${tag}`, "--jq", '.object.type + " " + .object.sha'])).trim();
      } catch (error: unknown) {
        if (error instanceof GhError && error.notFound) return null;
        throw error;
      }
      const [type, sha] = ref.split(" ");
      if (type === "commit") return sha;
      if (type === "tag") return (await gh(["api", `${api}/git/tags/${sha}`, "--jq", ".object.sha"])).trim();
      throw new Error(`tag ${tag} points at an unexpected object type ${type}`);
    }
  };
}
