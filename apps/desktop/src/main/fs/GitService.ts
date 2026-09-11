import { execFile } from "node:child_process";
import { simpleGit } from "simple-git";
import type { GitStatus } from "@cw-code/contracts";

export function parsePrNumber(stdout: string): number | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function worktreeNameFor(root: string): string {
  const stripped = root.replace(/[\\/]+$/, "");
  return stripped.split(/[/\\]/).filter(Boolean).pop() ?? stripped;
}

export function isAppManagedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".cw" || normalized.startsWith(".cw/");
}

function queryPrNumber(root: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("gh", ["pr", "view", "--json", "number", "--jq", ".number"], { cwd: root, timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parsePrNumber(String(stdout)));
    });
  });
}

export class GitService {
  async turnDiff(root: string, _since: number): Promise<string> {
    const git = simpleGit(root);
    try {
      const status = await git.diff();
      return status;
    } catch (err) {
      return `diff unavailable: ${(err as Error).message}`;
    }
  }

  async status(root: string): Promise<GitStatus> {
    const git = simpleGit(root);
    let branch = "detached";
    let dirtyCount = 0;
    try {
      const rev = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
      if (rev) branch = rev;
    } catch (err) {
      console.warn(`git branch failed: ${(err as Error).message}`);
    }
    try {
      const s = await git.status();
      const managedUntracked = s.files.filter((file) => file.index === "?" && isAppManagedPath(file.path)).length;
      dirtyCount =
        s.not_added.length + s.created.length + s.deleted.length + s.modified.length + s.renamed.length -
        managedUntracked;
      if (dirtyCount < 0) dirtyCount = 0;
    } catch (err) {
      console.warn(`git status failed: ${(err as Error).message}`);
    }
    let prNumber: number | null = null;
    try {
      prNumber = await queryPrNumber(root);
    } catch (err) {
      console.warn(`gh pr lookup failed: ${(err as Error).message}`);
      prNumber = null;
    }
    return {
      branch,
      dirtyCount,
      worktreeName: worktreeNameFor(root),
      prNumber,
      clean: dirtyCount === 0
    };
  }
}
