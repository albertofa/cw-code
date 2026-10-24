import type { IssueRef, RepoRef, RunRef } from "@cw-code/contracts";
import { GH_HOST } from "./githubAccount.js";

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)$/;
export const REPO_RE = /^[A-Za-z0-9._-]+$/;

export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_HOST_LENGTH = 253;

export function isValidHost(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HOST_LENGTH && HOST_RE.test(value);
}

export function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function assertRunId(runId: number): void {
  if (!isSafePositiveInt(runId)) throw new Error(`invalid check run id '${String(runId)}'`);
}

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
