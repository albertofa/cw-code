import type { IssueRef, RepoRef, RunRef } from "@cw-code/contracts";
import { GH_HOST } from "./githubAccount.js";
import { OWNER_RE, REPO_RE, assertRunId } from "./PullRequestService.js";

export function assertOwnerLogin(login: unknown): asserts login is string {
  if (typeof login !== "string" || !OWNER_RE.test(login)) throw new Error(`invalid organization '${String(login)}'`);
}

export function assertRepoRef(ref: unknown): asserts ref is RepoRef {
  if (!ref || typeof ref !== "object") throw new Error("invalid repository reference");
  const candidate = ref as Partial<RepoRef>;
  if (candidate.host !== GH_HOST) throw new Error(`unsupported GitHub host '${String(candidate.host)}'`);
  if (typeof candidate.owner !== "string" || !OWNER_RE.test(candidate.owner)) throw new Error(`invalid repository owner '${String(candidate.owner)}'`);
  if (typeof candidate.repo !== "string" || !REPO_RE.test(candidate.repo) || candidate.repo === "." || candidate.repo === "..") {
    throw new Error(`invalid repository name '${String(candidate.repo)}'`);
  }
}

export function assertRunRef(ref: unknown): asserts ref is RunRef {
  assertRepoRef(ref);
  assertRunId((ref as Partial<RunRef>).runId as number);
}

export function assertIssueRef(ref: unknown): asserts ref is IssueRef {
  assertRepoRef(ref);
  const number = (ref as Partial<IssueRef>).number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid issue number '${String(number)}'`);
}
