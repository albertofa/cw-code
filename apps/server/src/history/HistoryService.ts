import { spawn } from "node:child_process";
import type { HistoryCommitDetail, HistoryHead, HistoryLog, HistoryRef } from "@cw-code/contracts";
import { execWithStatus } from "../fs/GitService.js";
import { sanitizedChildEnv } from "../shellEnvironment.js";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import { LOG_FORMAT, mergeStashes, parseCommitShow, parseLog, parseRefs, parseStashList, REFS_FORMAT, SHOW_FORMAT, STASH_FORMAT } from "./historyParsers.js";

export const HISTORY_PATCH_MAX_CHARS = 400_000;
const READ_TIMEOUT_MS = 20_000;
const LOG_TIMEOUT_MS = 60_000;
const PATCH_MAX_BYTES = 4 * 1024 * 1024;

const READ_PREFIX = [
  "-c",
  "core.quotepath=off",
  "-c",
  "color.ui=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
  "-c",
  "log.showSignature=false",
  "--no-pager",
  "--no-optional-locks"
];

export interface HistorySnapshot {
  head: HistoryHead;
  refs: HistoryRef[];
}

function readEnv(): NodeJS.ProcessEnv {
  const env = sanitizedChildEnv(process.env, process.platform);
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  return env;
}

function failure(args: string[], stderr: string, code: number): Error {
  const message = stderr.trim() || `git ${args[0] ?? ""} exited with code ${code}`;
  return new Error(message);
}

export class HistoryService {
  private readonly snapshotsInFlight = new Map<string, Promise<HistorySnapshot>>();

  constructor(private readonly gitBinary: () => string) {}

  snapshot(root: string): Promise<HistorySnapshot> {
    const key = comparableRoot(root);
    const inFlight = this.snapshotsInFlight.get(key);
    if (inFlight) return inFlight;
    const promise = this.computeSnapshot(root).finally(() => {
      if (this.snapshotsInFlight.get(key) === promise) this.snapshotsInFlight.delete(key);
    });
    this.snapshotsInFlight.set(key, promise);
    return promise;
  }

  async log(root: string, limit: number): Promise<HistoryLog> {
    const [snapshot, stashResult] = await Promise.allSettled([this.computeSnapshot(root), this.read(root, ["stash", "list", STASH_FORMAT])]);
    if (snapshot.status === "rejected") throw snapshot.reason;
    if (stashResult.status === "rejected") throw stashResult.reason;
    const { head, refs } = snapshot.value;
    const stashOutput = stashResult.value;
    const stashes = parseStashList(stashOutput);
    const allRefs = [...refs, ...stashes.map((entry) => entry.ref)];
    if (head.sha === null && refs.length === 0) return { head, refs: allRefs, commits: [], truncated: false };
    const walk = ["--branches", "--remotes", "--tags", ...(head.sha === null ? [] : ["HEAD"])];
    const stdout = await this.read(root, ["log", "--date-order", `--max-count=${limit + 1}`, LOG_FORMAT, ...walk, "--"], LOG_TIMEOUT_MS);
    const parsed = parseLog(stdout);
    const truncated = parsed.length > limit;
    const commits = mergeStashes(truncated ? parsed.slice(0, limit) : parsed, stashes.map((entry) => entry.commit));
    return { head, refs: allRefs, commits, truncated };
  }

  async commit(root: string, sha: string): Promise<HistoryCommitDetail> {
    const exists = await this.run(root, ["cat-file", "-e", `${sha}^{commit}`]);
    if (exists.code !== 0) throw Object.assign(new Error(`commit ${sha} not found`), { code: "not-found" });
    const detail = parseCommitShow(await this.read(root, ["show", "-s", SHOW_FORMAT, sha]));
    const diffArgs =
      detail.parents.length === 0
        ? ["diff-tree", "-p", "-M", "--root", "--no-commit-id", "--no-ext-diff", sha]
        : ["diff", "-M", "--no-ext-diff", detail.parents[0]!, sha];
    const { text, truncated } = await this.readPatch(root, diffArgs);
    return { ...detail, isStash: false, patch: text, patchTruncated: truncated };
  }

  private async computeSnapshot(root: string): Promise<HistorySnapshot> {
    const [sha, branch, refs] = await Promise.all([
      this.run(root, ["rev-parse", "--verify", "-q", "HEAD"]),
      this.run(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
      this.run(root, ["for-each-ref", REFS_FORMAT, "refs/heads", "refs/remotes", "refs/tags"])
    ]);
    if (sha.code !== 0 && sha.code !== 1) throw failure(["rev-parse"], sha.stderr, sha.code);
    if (refs.code !== 0) throw failure(["for-each-ref"], refs.stderr, refs.code);
    const shaValue = sha.code === 0 ? sha.stdout.trim() : "";
    const branchValue = branch.code === 0 ? branch.stdout.trim() : "";
    return {
      head: { sha: shaValue || null, branch: branchValue || null, detached: branch.code !== 0 },
      refs: parseRefs(refs.stdout)
    };
  }

  private run(root: string, args: string[], timeout = READ_TIMEOUT_MS) {
    return execWithStatus(this.gitBinary(), [...READ_PREFIX, ...args], root, timeout, readEnv());
  }

  private async read(root: string, args: string[], timeout = READ_TIMEOUT_MS): Promise<string> {
    const result = await this.run(root, args, timeout);
    if (result.code !== 0) throw failure(args, result.stderr, result.code);
    return result.stdout;
  }

  private readPatch(root: string, args: string[]): Promise<{ text: string; truncated: boolean }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.gitBinary(), [...READ_PREFIX, ...args], { cwd: root, env: readEnv(), windowsHide: true });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let capped = false;
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, READ_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        if (capped) return;
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes < PATCH_MAX_BYTES) return;
        capped = true;
        child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`git ${args[0] ?? ""} timed out after ${READ_TIMEOUT_MS}ms`));
        if (!capped && code !== 0) return reject(failure(args, stderr, code ?? -1));
        const text = Buffer.concat(chunks).toString("utf8");
        if (!capped && text.length <= HISTORY_PATCH_MAX_CHARS) return resolvePromise({ text, truncated: false });
        const cut = text.lastIndexOf("\n", HISTORY_PATCH_MAX_CHARS);
        resolvePromise({ text: text.slice(0, cut > 0 ? cut + 1 : HISTORY_PATCH_MAX_CHARS), truncated: true });
      });
    });
  }
}
