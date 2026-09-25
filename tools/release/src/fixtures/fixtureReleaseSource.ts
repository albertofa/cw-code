import type { ReleaseInfo, ReleaseSource } from "../releaseSource.ts";

export interface FixtureRelease extends ReleaseInfo {
  sha: string;
}

export interface FixtureReleaseSourceOptions {
  releases: FixtureRelease[];
  head: string;
  remoteMainSha?: string;
  commitLog: Array<{ sha: string; subject: string }>;
  filesAtSha?: Record<string, Record<string, string>>;
}

function commitsBetween(commitLog: Array<{ sha: string; subject: string }>, fromSha: string | null, toSha: string): string[] {
  const toIndex = commitLog.findIndex((entry) => entry.sha === toSha);
  if (toIndex === -1) {
    throw new Error(`Unknown ref "${toSha}" in fixture commit log`);
  }
  const fromIndex = fromSha ? commitLog.findIndex((entry) => entry.sha === fromSha) : -1;
  if (fromSha && fromIndex === -1) {
    throw new Error(`Unknown ref "${fromSha}" in fixture commit log`);
  }
  return commitLog.slice(fromIndex + 1, toIndex + 1).map((entry) => entry.subject);
}

export function createFixtureReleaseSource(options: FixtureReleaseSourceOptions): ReleaseSource {
  const { releases, head, commitLog, filesAtSha = {} } = options;
  const tagShas = new Map(releases.map((release) => [release.tagName, release.sha]));

  return {
    async listReleases(): Promise<ReleaseInfo[]> {
      return releases.map(({ sha: _sha, ...release }) => release);
    },
    async tagSha(tag: string): Promise<string | null> {
      return tagShas.get(tag) ?? null;
    },
    async headSha(ref = "HEAD"): Promise<string> {
      if (ref === "HEAD") return head;
      return tagShas.get(ref) ?? ref;
    },
    async remoteMainSha(): Promise<string> {
      return options.remoteMainSha ?? head;
    },
    async logSubjects(fromRef: string | null, toRef: string): Promise<string[]> {
      const toSha = tagShas.get(toRef) ?? toRef;
      const fromSha = fromRef ? (tagShas.get(fromRef) ?? fromRef) : null;
      return commitsBetween(commitLog, fromSha, toSha).reverse();
    },
    async showFile(sha: string, path: string): Promise<string> {
      const contents = filesAtSha[sha]?.[path];
      if (contents === undefined) {
        throw new Error(`Unknown file "${path}" at "${sha}" in fixture`);
      }
      return contents;
    }
  };
}
