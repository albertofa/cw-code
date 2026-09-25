export interface ReleaseInfo {
  tagName: string;
  targetCommitish: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  name: string;
  body: string;
}

export interface ReleaseSource {
  listReleases(): Promise<ReleaseInfo[]>;
  tagSha(tag: string): Promise<string | null>;
  headSha(ref?: string): Promise<string>;
  isAncestorOfMain(sha: string): Promise<boolean>;
  logSubjects(fromRef: string | null, toRef: string): Promise<string[]>;
  showFile(sha: string, path: string): Promise<string>;
}
