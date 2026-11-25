import { createHash } from "node:crypto";
import type { HistoryCommit, HistoryCommitDetail, HistoryRef, HistoryRefKind, HistoryWorktree } from "@cw-code/contracts";

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

export const REFS_FORMAT = "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream)%1f%(upstream:track,nobracket)%1f%(HEAD)";
export const LOG_FORMAT = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s";
export const STASH_FORMAT = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%gd%x1f%s";
export const SHOW_FORMAT = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%b";

function classifyRef(fullName: string): { kind: HistoryRefKind; name: string } | null {
  if (fullName.startsWith("refs/heads/")) return { kind: "local", name: fullName.slice("refs/heads/".length) };
  if (fullName.startsWith("refs/remotes/")) {
    if (fullName.endsWith("/HEAD")) return null;
    return { kind: "remote", name: fullName.slice("refs/remotes/".length) };
  }
  if (fullName.startsWith("refs/tags/")) return { kind: "tag", name: fullName.slice("refs/tags/".length) };
  return null;
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === "gone") return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false };
}

function shortUpstream(upstream: string): string | null {
  if (upstream === "") return null;
  if (upstream.startsWith("refs/remotes/")) return upstream.slice("refs/remotes/".length);
  if (upstream.startsWith("refs/heads/")) return upstream.slice("refs/heads/".length);
  return upstream;
}

function splitParents(parents: string | undefined): string[] {
  return parents ? parents.split(" ").filter(Boolean) : [];
}

function records(stdout: string): string[] {
  return stdout
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/\r?\n$/, ""))
    .filter((record) => record !== "");
}

export function parseRefs(stdout: string): HistoryRef[] {
  const refs: HistoryRef[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const [fullName = "", objectName = "", derefName = "", upstream = "", track = "", head = ""] = line.split(FIELD_SEPARATOR);
    const classified = classifyRef(fullName);
    if (!classified) continue;
    const parsedTrack = parseTrack(track);
    refs.push({
      fullName,
      name: classified.name,
      kind: classified.kind,
      target: derefName || objectName,
      isCurrent: head === "*",
      upstream: shortUpstream(upstream),
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      upstreamGone: parsedTrack.gone
    });
  }
  return refs;
}

export function parseLog(stdout: string): HistoryCommit[] {
  return records(stdout).map((record) => {
    const [sha = "", parents, authorName = "", authorEmail = "", authorDate = "0", committerDate = "0", ...subject] = record.split(FIELD_SEPARATOR);
    return {
      sha,
      parents: splitParents(parents),
      authorName,
      authorEmail,
      authorDate: Number(authorDate),
      committerDate: Number(committerDate),
      subject: subject.join(FIELD_SEPARATOR),
      isStash: false
    };
  });
}

export function parseStashList(stdout: string): { commit: HistoryCommit; ref: HistoryRef }[] {
  return records(stdout).map((record) => {
    const [sha = "", parents, authorName = "", authorEmail = "", authorDate = "0", committerDate = "0", selector = "", ...subject] =
      record.split(FIELD_SEPARATOR);
    const base = splitParents(parents)[0];
    return {
      commit: {
        sha,
        parents: base ? [base] : [],
        authorName,
        authorEmail,
        authorDate: Number(authorDate),
        committerDate: Number(committerDate),
        subject: subject.join(FIELD_SEPARATOR),
        isStash: true
      },
      ref: {
        fullName: selector,
        name: selector,
        kind: "stash",
        target: sha,
        isCurrent: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamGone: false
      }
    };
  });
}

export function mergeStashes(commits: HistoryCommit[], stashes: HistoryCommit[]): HistoryCommit[] {
  const result = [...commits];
  for (const stash of stashes) {
    let index = result.findIndex((commit) => commit.committerDate < stash.committerDate);
    if (index === -1) index = result.length;
    const baseIndex = result.findIndex((commit) => commit.sha === stash.parents[0]);
    if (baseIndex !== -1 && baseIndex < index) index = baseIndex;
    result.splice(index, 0, stash);
  }
  return result;
}

export function parseCommitShow(stdout: string): Omit<HistoryCommitDetail, "isStash" | "patch" | "patchTruncated"> {
  const fields = stdout.replace(/\r?\n$/, "").split(FIELD_SEPARATOR);
  const [sha = "", parents, authorName = "", authorEmail = "", authorDate = "0", committerName = "", committerEmail = "", committerDate = "0", subject = ""] = fields;
  return {
    sha,
    parents: splitParents(parents),
    authorName,
    authorEmail,
    authorDate: Number(authorDate),
    committerName,
    committerEmail,
    committerDate: Number(committerDate),
    subject,
    body: fields.slice(9).join(FIELD_SEPARATOR).replace(/\s+$/, "")
  };
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export const HISTORY_DEFAULT_LIMIT = 2000;
export const HISTORY_MAX_LIMIT = 20000;

export function parseHistoryLimit(value: unknown): number {
  if (value === undefined) return HISTORY_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > HISTORY_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}`);
  }
  return value;
}

export function comparableGitPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

export function worktreeKey(path: string): string {
  return createHash("sha1").update(comparableGitPath(path)).digest("hex").slice(0, 16);
}

export function parseWorktreeList(stdout: string, toplevel: string): HistoryWorktree[] {
  const worktrees: HistoryWorktree[] = [];
  const current = toplevel === "" ? null : comparableGitPath(toplevel);
  let first = true;
  for (const block of stdout.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    const isMain = first;
    first = false;
    if (lines.includes("bare")) continue;
    const path = pathLine.slice("worktree ".length);
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null;
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length) ?? null;
    const segments = path.split(/[\\/]/).filter(Boolean);
    worktrees.push({
      key: worktreeKey(path),
      path,
      name: segments[segments.length - 1] ?? path,
      branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
      head,
      isCurrent: current !== null && comparableGitPath(path) === current,
      isMain,
      sessionId: null
    });
  }
  return worktrees;
}
