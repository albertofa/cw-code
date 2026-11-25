export type HistoryRefKind = "local" | "remote" | "tag" | "stash";

export interface HistoryRef {
  fullName: string;
  name: string;
  kind: HistoryRefKind;
  target: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
}

export interface HistoryHead {
  sha: string | null;
  branch: string | null;
  detached: boolean;
}

export interface HistoryCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerDate: number;
  subject: string;
  isStash: boolean;
}

export interface HistoryLog {
  head: HistoryHead;
  refs: HistoryRef[];
  commits: HistoryCommit[];
  truncated: boolean;
}

export interface HistoryCommitDetail extends HistoryCommit {
  committerName: string;
  committerEmail: string;
  body: string;
  patch: string;
  patchTruncated: boolean;
}

export type HistoryTopicData = {
  head: HistoryHead | null;
  refs: HistoryRef[];
  rev: number;
  error: string | null;
};

export interface HistoryAvatarAuthor {
  email: string;
  shas: string[];
}

export interface HistoryAvatars {
  avatars: Record<string, string | null>;
  pending: string[];
}
