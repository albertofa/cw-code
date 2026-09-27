export interface RemoteAsset {
  id: number;
  name: string;
  size: number;
  state: string;
}

export interface RemoteRelease {
  id: number;
  tagName: string;
  targetCommitish: string;
  draft: boolean;
  prerelease: boolean;
  name: string;
  body: string;
  htmlUrl: string;
  assets: RemoteAsset[];
}

export interface CreateDraftInput {
  tag: string;
  targetSha: string;
  name: string;
  body: string;
  prerelease: boolean;
}

export interface PublishFlags {
  prerelease: boolean;
  makeLatest: boolean;
}

export interface GitHubReleaseClient {
  repositoryIsPublic(): Promise<boolean>;
  listReleases(): Promise<RemoteRelease[]>;
  createDraft(input: CreateDraftInput): Promise<RemoteRelease>;
  updateDraft(releaseId: number, fields: { name: string; body: string; prerelease: boolean }): Promise<void>;
  getRelease(releaseId: number): Promise<RemoteRelease>;
  uploadAsset(release: RemoteRelease, path: string, name: string): Promise<void>;
  deleteAsset(assetId: number): Promise<void>;
  downloadAsset(release: RemoteRelease, asset: RemoteAsset, destinationDir: string): Promise<string>;
  publish(releaseId: number, flags: PublishFlags): Promise<RemoteRelease>;
  remoteTagSha(tag: string): Promise<string | null>;
}
