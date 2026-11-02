import type { PrRef, RepoRef, SessionPrLink } from "@cw-code/contracts";
import { prKey, prRefFromUrl } from "@cw-code/shared/prRef";
import { GH_HOST } from "../github/githubAccount.js";
import { assertPrRef } from "../github/PullRequestService.js";

const QUALIFIED_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const NUMBER_RE = /^#?(\d+)$/;

function sameRepo(remote: RepoRef, owner: string, repo: string): boolean {
  return remote.owner.toLowerCase() === owner.toLowerCase() && remote.repo.toLowerCase() === repo.toLowerCase();
}

async function refFromShortForm(text: string, remote: () => Promise<RepoRef | null>): Promise<PrRef> {
  const qualified = QUALIFIED_RE.exec(text);
  if (qualified) {
    const [, owner, repo, number] = qualified;
    const local = await remote();
    return { host: local && sameRepo(local, owner, repo) ? local.host : GH_HOST, owner, repo, number: Number(number) };
  }
  const bare = NUMBER_RE.exec(text);
  if (!bare) throw new Error(`'${text}' is not a pull request; pass a pull request URL, owner/repo#123 or a number`);
  const local = await remote();
  if (!local) throw new Error(`this checkout has no GitHub remote; pass the pull request URL or owner/repo#${bare[1]}`);
  return { host: local.host, owner: local.owner, repo: local.repo, number: Number(bare[1]) };
}

export async function resolvePrInput(input: string, remote: () => Promise<RepoRef | null>): Promise<PrRef> {
  const text = input.trim();
  const ref = prRefFromUrl(text) ?? (await refFromShortForm(text, remote));
  assertPrRef(ref);
  return ref;
}

export function findLinkIgnoringCase(prs: SessionPrLink[] | undefined, ref: PrRef): SessionPrLink | undefined {
  const key = prKey(ref).toLowerCase();
  return prs?.find((link) => prKey(link.ref).toLowerCase() === key);
}
