import type { GitHubContext, ProjectGitHubRepo } from "@cw-code/contracts";

const GITHUB_HOST = "github.com";

export function orgFromRepos(repos: ProjectGitHubRepo[], viewer: string | null): string | null {
  if (!viewer) return null;
  const login = viewer.toLowerCase();
  return repos.find((repo) => repo.host.toLowerCase() === GITHUB_HOST && repo.owner.toLowerCase() !== login)?.owner ?? null;
}

export function githubContext(repos: ProjectGitHubRepo[], viewer: string | null): GitHubContext {
  return { viewer, org: orgFromRepos(repos, viewer), projectRepos: repos };
}
