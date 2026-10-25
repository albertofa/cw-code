export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileStatInfo {
  mtimeMs: number;
  size: number;
}

export type FileReadResult =
  | { kind: "text"; content: string; mtimeMs: number; size: number; readOnly: boolean; readOnlyReason?: "large" | "encoding" }
  | { kind: "binary"; mtimeMs: number; size: number }
  | { kind: "tooLarge"; mtimeMs: number; size: number }
  | { kind: "missing" };

export type GitFileState = "conflict" | "modified" | "added" | "renamed" | "deleted" | "untracked" | "ignored";

export interface GitFileDecoration {
  path: string;
  state: GitFileState;
  isDir: boolean;
}

export interface GitDecorations {
  available: boolean;
  entries: GitFileDecoration[];
}

export interface TextSearchQuery {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include?: string;
  exclude?: string;
  maxResults?: number;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  preview: string;
  ranges: Array<[number, number]>;
}

export interface TextSearchResult {
  matches: TextSearchMatch[];
  truncated: boolean;
  error: string | null;
}

export type GitBaseline = { kind: "tracked"; content: string } | { kind: "untracked" } | { kind: "none" };

export interface FsChangeEvent {
  sessionId: string;
  paths: string[];
}

export type FilesTopicData = { decorations: GitDecorations };
