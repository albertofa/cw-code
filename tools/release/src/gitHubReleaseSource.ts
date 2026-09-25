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
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function createGitHubReleaseSource(options: GitHubReleaseSourceOptions): ReleaseSource {
  const { owner, repo, cwd } = options;

  return {
    async listReleases(): Promise<ReleaseInfo[]> {
      const stdout = await run(
        "gh",
        ["api", `repos/${owner}/${repo}/releases`, "--paginate", "--jq", ".[]"],
        cwd
      );
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
            htmlUrl: raw.html_url
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

    async logSubjects(fromRef: string | null, toRef: string): Promise<string[]> {
      const range = fromRef ? `${fromRef}..${toRef}` : toRef;
      const stdout = await run("git", ["log", "--first-parent", "--pretty=%s", range], cwd);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  };
}
