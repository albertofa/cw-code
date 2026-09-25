import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseInfo, ReleaseSource } from "./releaseSource.ts";

const execFileAsync = promisify(execFile);

interface GitHubReleaseSourceOptions {
  owner: string;
  repo: string;
  cwd: string;
}

interface RawRelease {
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  name: string | null;
  body: string | null;
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function createGitHubReleaseSource(options: GitHubReleaseSourceOptions): ReleaseSource {
  const { owner, repo, cwd } = options;

  return {
    async listReleases(): Promise<ReleaseInfo[]> {
      let stdout: string;
      try {
        stdout = await run(
          "gh",
          [
            "api",
            `repos/${owner}/${repo}/releases?per_page=100`,
            "--paginate",
            "--jq",
            ".[] | {tag_name, target_commitish, draft, prerelease, published_at, html_url, name, body}"
          ],
          cwd
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`gh api could not list releases (check network access and gh auth, e.g. a read-only GH_TOKEN in CI): ${message}`);
      }
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const raw = JSON.parse(line) as RawRelease;
          return {
            tagName: raw.tag_name,
            targetCommitish: raw.target_commitish,
            draft: raw.draft,
            prerelease: raw.prerelease,
            publishedAt: raw.published_at ?? "",
            htmlUrl: raw.html_url,
            name: raw.name ?? "",
            body: raw.body ?? ""
          };
        });
    },

    async tagSha(tag: string): Promise<string | null> {
      try {
        const stdout = await run("git", ["rev-parse", "--verify", "-q", `refs/tags/${tag}^{}`], cwd);
        return stdout.trim();
      } catch {
        return null;
      }
    },

    async headSha(ref = "HEAD"): Promise<string> {
      const stdout = await run("git", ["rev-parse", ref], cwd);
      return stdout.trim();
    },

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
      let status: string;
      try {
        status = (await run("gh", ["api", `repos/${owner}/${repo}/compare/${ancestor}...${descendant}`, "--jq", ".status"], cwd)).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`gh api could not compare ${ancestor} with ${descendant} on GitHub: ${message}`);
      }
      if (!["identical", "ahead", "behind", "diverged"].includes(status)) {
        throw new Error(`GitHub compare ${ancestor}...${descendant} returned an unexpected status "${status}"`);
      }
      return status === "identical" || status === "ahead";
    },

    async listTags(): Promise<string[]> {
      const stdout = await run("git", ["tag", "--list", "v*"], cwd);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    async logSubjects(fromRef: string | null, toRef: string): Promise<string[]> {
      const range = fromRef ? `${fromRef}..${toRef}` : toRef;
      const stdout = await run("git", ["log", "--first-parent", "--pretty=%s", range], cwd);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    async showFile(sha: string, path: string): Promise<string> {
      return run("git", ["show", `${sha}:${path}`], cwd);
    }
  };
}
