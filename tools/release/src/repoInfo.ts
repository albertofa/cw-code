export interface RepoInfo {
  owner: string;
  repo: string;
}

const GITHUB_HOMEPAGE_PATTERN = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function parseGitHubHomepage(homepage: string): RepoInfo {
  const match = GITHUB_HOMEPAGE_PATTERN.exec(homepage);
  if (!match) {
    throw new Error(`Could not parse a GitHub owner/repo from homepage "${homepage}"`);
  }
  const [, owner, repo] = match;
  return { owner, repo };
}
