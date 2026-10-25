import type { PrRef, ProjectGitHubRepo, RepoRef } from "@cw-code/contracts";

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export function prKey(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prRefFromUrl(url: string): PrRef | null {
  const match = PR_URL_RE.exec(url.trim());
  if (!match) return null;
  const number = Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], number };
}

export function prRefLabel(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function projectIdFor(repos: ProjectGitHubRepo[], ref: RepoRef): string | null {
  const host = ref.host.toLowerCase();
  const owner = ref.owner.toLowerCase();
  const repo = ref.repo.toLowerCase();
  const match = repos.find((item) => item.host.toLowerCase() === host && item.owner.toLowerCase() === owner && item.repo.toLowerCase() === repo);
  return match?.projectId ?? null;
}
