import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { carriesPlanMarker, releaseBody } from "./planMarker.ts";
import type { ReleasePlan } from "./planValidation.ts";
import { sha512Base64 } from "./rehash.ts";
import { type ReleaseAssetFile, isFeedManifest } from "./releaseAssets.ts";
import type { GitHubReleaseClient, RemoteAsset, RemoteRelease } from "./releaseClient.ts";
import { verifyPlan } from "./releasePlan.ts";
import type { ReleaseSource } from "./releaseSource.ts";

export const RECOVERY_RUNBOOK = "docs/operations/releases.md#recovery";

export interface PublishInput {
  plan: ReleasePlan;
  dir: string;
  assets: ReleaseAssetFile[];
  client: GitHubReleaseClient;
  source: ReleaseSource;
  workDir: string;
  log?: (line: string) => void;
}

export interface PublishResult {
  status: "published" | "already-published";
  releaseId: number;
  htmlUrl: string;
  resumed: boolean;
  uploaded: string[];
  reused: string[];
  replaced: string[];
}

type AssetAction = "reuse" | "upload" | "replace";

class PublishContext {
  private downloads = 0;
  readonly input: PublishInput;

  constructor(input: PublishInput) {
    this.input = input;
  }

  log(line: string): void {
    this.input.log?.(line);
  }

  async remoteDigest(release: RemoteRelease, asset: RemoteAsset): Promise<string> {
    this.downloads += 1;
    const dir = join(this.input.workDir, `download-${release.id}-${this.downloads}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      return await sha512Base64(await this.input.client.downloadAsset(release, asset, dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function describeReasons(reasons: string[]): string {
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

async function assetMismatches(context: PublishContext, release: RemoteRelease): Promise<string[]> {
  const { assets } = context.input;
  const expected = new Map(assets.map((asset) => [asset.name, asset]));
  const problems: string[] = [];
  for (const remote of release.assets) {
    if (!expected.has(remote.name)) problems.push(`unexpected asset ${remote.name}`);
  }
  for (const asset of assets) {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    if (!remote) {
      problems.push(`${asset.name} is missing`);
    } else if (remote.state !== "uploaded") {
      problems.push(`${asset.name} is in state ${remote.state}`);
    } else if (remote.size !== asset.size) {
      problems.push(`${asset.name} is ${remote.size} bytes, expected ${asset.size}`);
    } else if ((await context.remoteDigest(release, remote)) !== asset.sha512) {
      problems.push(`${asset.name} downloaded bytes differ from the validated release set`);
    }
  }
  return problems;
}

async function confirmPublishedState(context: PublishContext, release: RemoteRelease): Promise<void> {
  const { plan, client } = context.input;
  const problems: string[] = [];
  if (release.draft) problems.push("the release is still a draft");
  if (release.prerelease !== plan.prerelease) problems.push(`prerelease is ${release.prerelease}, expected ${plan.prerelease}`);
  const tagSha = await client.remoteTagSha(plan.tag);
  if (tagSha !== plan.sourceSha) problems.push(`tag ${plan.tag} points at ${tagSha ?? "nothing"}, expected ${plan.sourceSha}`);
  if (problems.length > 0) {
    throw new Error(`Release ${plan.tag} is public but inconsistent; follow ${RECOVERY_RUNBOOK}:\n${describeReasons(problems)}`);
  }
}

async function confirmAlreadyPublished(context: PublishContext, release: RemoteRelease): Promise<PublishResult> {
  const { plan } = context.input;
  const provenance: string[] = [];
  if (release.targetCommitish !== plan.sourceSha) provenance.push(`it targets ${release.targetCommitish}, the plan builds ${plan.sourceSha}`);
  if (!carriesPlanMarker(release.body, plan.sourceSha)) provenance.push("it does not carry this plan's marker");
  const problems = provenance.length > 0 ? provenance : await assetMismatches(context, release);
  if (problems.length > 0) {
    throw new Error(`${plan.tag} is already published and differs from this release set; published releases are never overwritten:\n${describeReasons(problems)}`);
  }
  await confirmPublishedState(context, release);
  context.log(`${plan.tag} is already published with identical assets; nothing to do`);
  return { status: "already-published", releaseId: release.id, htmlUrl: release.htmlUrl, resumed: false, uploaded: [], reused: context.input.assets.map((asset) => asset.name), replaced: [] };
}

async function decideActions(context: PublishContext, release: RemoteRelease): Promise<Map<string, AssetAction>> {
  const actions = new Map<string, AssetAction>();
  for (const asset of context.input.assets) {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    if (!remote) {
      actions.set(asset.name, "upload");
    } else if (remote.state === "uploaded" && remote.size === asset.size && (await context.remoteDigest(release, remote)) === asset.sha512) {
      actions.set(asset.name, "reuse");
    } else {
      actions.set(asset.name, "replace");
    }
  }
  const payloadChanges = context.input.assets.some((asset) => !isFeedManifest(asset.name) && actions.get(asset.name) !== "reuse");
  if (payloadChanges) {
    for (const asset of context.input.assets) {
      if (isFeedManifest(asset.name) && actions.get(asset.name) === "reuse") actions.set(asset.name, "replace");
    }
  }
  return actions;
}

async function syncAssets(context: PublishContext, release: RemoteRelease): Promise<Pick<PublishResult, "uploaded" | "reused" | "replaced">> {
  const { assets, client, dir } = context.input;
  const unexpected = release.assets.filter((remote) => !assets.some((asset) => asset.name === remote.name));
  if (unexpected.length > 0) {
    throw new Error(`Draft ${release.tagName} carries assets this release set does not own (${unexpected.map((asset) => asset.name).join(", ")}); remove them by hand, see ${RECOVERY_RUNBOOK}`);
  }
  const actions = await decideActions(context, release);
  const replaced: string[] = [];
  const ordered = [...assets.filter((asset) => isFeedManifest(asset.name)), ...assets.filter((asset) => !isFeedManifest(asset.name))];
  for (const asset of ordered) {
    const remote = release.assets.find((entry) => entry.name === asset.name);
    if (actions.get(asset.name) === "replace" && remote) {
      await client.deleteAsset(remote.id);
      replaced.push(asset.name);
      context.log(`deleted draft asset ${asset.name} (${remote.state}, ${remote.size} bytes) to replace it`);
    }
  }
  const uploaded: string[] = [];
  const reused: string[] = [];
  for (const asset of assets) {
    if (actions.get(asset.name) === "reuse") {
      reused.push(asset.name);
      continue;
    }
    await client.uploadAsset(release, join(dir, asset.name), asset.name);
    uploaded.push(asset.name);
    context.log(`uploaded ${asset.name} (${asset.size} bytes)`);
  }
  return { uploaded, reused, replaced };
}

async function requireFreshPlan(context: PublishContext, draftId: number | null): Promise<void> {
  const { plan, source, client } = context.input;
  const verdict = await verifyPlan(plan, source);
  if (!verdict.ok) {
    throw new Error(`Plan ${plan.tag} can no longer be published (nothing was made public):\n${describeReasons(verdict.reasons)}`);
  }
  if ((verdict.resumeDraft !== null) !== (draftId !== null)) {
    throw new Error(`The releases for ${plan.tag} changed while publishing; rerun the publish job`);
  }
  const tagSha = await client.remoteTagSha(plan.tag);
  if (tagSha !== null) throw new Error(`Tag ${plan.tag} appeared on GitHub (at ${tagSha}) before publication; nothing was made public`);
}

export async function publishRelease(input: PublishInput): Promise<PublishResult> {
  const context = new PublishContext(input);
  const { plan, client } = input;
  if (!(await client.repositoryIsPublic())) {
    throw new Error("The repository is not public, so clients could not download updates anonymously; see docs/operations/releases.md#distribution-repository");
  }

  const matching = (await client.listReleases()).filter((release) => release.tagName === plan.tag);
  if (matching.length > 1) throw new Error(`${matching.length} releases use tag ${plan.tag}; resolve the duplicates by hand, see ${RECOVERY_RUNBOOK}`);
  const [existing] = matching;
  if (existing && !existing.draft) return confirmAlreadyPublished(context, existing);

  await requireFreshPlan(context, existing?.id ?? null);
  const body = releaseBody(plan.notes, plan.sourceSha);
  let release: RemoteRelease;
  if (existing) {
    release = existing;
    if (existing.body !== body || existing.name !== plan.tag || existing.prerelease !== plan.prerelease) {
      await client.updateDraft(existing.id, { name: plan.tag, body, prerelease: plan.prerelease });
    }
    context.log(`resuming draft ${existing.id} for ${plan.tag}`);
  } else {
    release = await client.createDraft({ tag: plan.tag, targetSha: plan.sourceSha, name: plan.tag, body, prerelease: plan.prerelease });
    context.log(`created draft ${release.id} for ${plan.tag} at ${plan.sourceSha}`);
  }
  if (release.targetCommitish !== plan.sourceSha) {
    throw new Error(`Draft ${release.id} targets ${release.targetCommitish}, expected ${plan.sourceSha}; nothing was made public`);
  }

  const sync = await syncAssets(context, release);
  const refreshed = await client.getRelease(release.id);
  const mismatches = await assetMismatches(context, refreshed);
  if (mismatches.length > 0) {
    throw new Error(`Draft ${plan.tag} does not hold the validated release set; it stays a draft, rerun the publish job:\n${describeReasons(mismatches)}`);
  }

  await requireFreshPlan(context, refreshed.id);
  const published = await client.publish(refreshed.id, { prerelease: plan.prerelease, makeLatest: plan.makeLatest });
  await confirmPublishedState(context, published);
  context.log(`published ${plan.tag} (${published.htmlUrl})`);
  return { status: "published", releaseId: published.id, htmlUrl: published.htmlUrl, resumed: existing !== undefined, ...sync };
}
