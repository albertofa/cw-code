import type { FeedMonitorHttp } from "./clientHttp.ts";
import { markedSourceSha } from "./planMarker.ts";
import { type PublishedCheck, check, parseJsonObject } from "./publishedCheck.ts";
import { ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME, STABLE_FEED_NAME, installerNameFor, publishableAssetNames } from "./releaseAssets.ts";
import { type ParsedVersion, compareVersions, formatVersion, parseTag } from "./semver.ts";
import { blockMapNameOf, validateSigningManifest } from "./signingManifest.ts";
import { type UpdateInfo, parseUpdateInfo } from "./updateInfoYaml.ts";

export const FEED_MONITOR_RUNBOOK = "docs/operations/rollout.md#feed-monitor-failures";

export type FeedChannel = "stable" | "alpha";
export type ChannelStatus = "healthy" | "not-yet" | "failed";

export interface ChannelReport {
  channel: FeedChannel;
  status: ChannelStatus;
  tag: string | null;
  sourceSha: string | null;
  notice: string | null;
  checks: PublishedCheck[];
}

export interface FeedMonitorReport {
  ok: boolean;
  attempts: number;
  listing: PublishedCheck;
  channels: ChannelReport[];
  summary: string;
}

export interface FeedMonitorInput {
  owner: string;
  repo: string;
  http: FeedMonitorHttp;
  verifyInstallerDigest: boolean;
}

export interface MonitorRetryOptions {
  attempts: number;
  initialDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

interface ListedAsset {
  name: string;
  size: number;
  state: string;
}

interface PipelineRelease {
  tag: string;
  version: ParsedVersion;
  sourceSha: string;
  assets: ListedAsset[];
}

const SEMVER_TAG = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const HREF_TAG = /\/tag\/(v?[^/]+)$/;

function statusText(status: number, body = ""): string {
  return status === 0 ? body || "no response" : `HTTP ${status}`;
}

function toListedAsset(value: unknown): ListedAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, size, state } = value as Record<string, unknown>;
  return typeof name === "string" && typeof size === "number" && typeof state === "string" ? { name, size, state } : null;
}

export function pipelineReleasesOf(body: string): PipelineRelease[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const releases: PipelineRelease[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (raw.draft !== false || typeof raw.tag_name !== "string") continue;
    const version = parseTag(raw.tag_name);
    const sourceSha = markedSourceSha(typeof raw.body === "string" ? raw.body : null);
    if (!version || !sourceSha) continue;
    const assets = Array.isArray(raw.assets) ? raw.assets.map(toListedAsset).filter((asset): asset is ListedAsset => asset !== null) : [];
    releases.push({ tag: raw.tag_name, version, sourceSha, assets });
  }
  return releases;
}

export function alphaClientTag(atomXml: string): string | null {
  for (const entry of atomXml.split(/<entry[\s>]/).slice(1)) {
    const href = /<link\b[^>]*\bhref="([^"]+)"/.exec(entry)?.[1];
    const tag = href ? HREF_TAG.exec(href)?.[1] : undefined;
    if (!tag) continue;
    const semver = SEMVER_TAG.exec(tag);
    if (!semver) continue;
    const channel = semver[1] ?? null;
    if (channel === null || channel === "alpha" || channel === "beta") return tag;
  }
  return null;
}

function highest(releases: PipelineRelease[]): PipelineRelease | null {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function manifestCheck(http: FeedMonitorHttp, url: string, release: PipelineRelease): Promise<{ result: PublishedCheck; info: UpdateInfo | null; text: string | null }> {
  const response = await http.text(url, "*/*");
  if (response.status !== 200) return { result: check("channel-manifest", url, [statusText(response.status, response.body)], ""), info: null, text: null };
  try {
    const info = parseUpdateInfo(response.body);
    const version = formatVersion(release.version);
    const problems: string[] = [];
    if (info.version !== version) problems.push(`advertises ${info.version}, expected ${version}`);
    if (info.path !== installerNameFor(version)) problems.push(`points at ${info.path}, expected ${installerNameFor(version)}`);
    return { result: check("channel-manifest", url, problems, `advertises ${version}`), info, text: response.body };
  } catch (error: unknown) {
    return { result: check("channel-manifest", url, [error instanceof Error ? error.message : String(error)], ""), info: null, text: null };
  }
}

function assetListCheck(base: string, release: PipelineRelease): PublishedCheck {
  const version = formatVersion(release.version);
  const expected = publishableAssetNames({ version, channel: release.version.channel });
  const names = release.assets.map((asset) => asset.name);
  const problems: string[] = [];
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0) problems.push(`missing assets: ${missing.join(", ")}`);
  const extra = names.filter((name) => !expected.includes(name));
  if (extra.length > 0) problems.push(`unexpected assets: ${extra.join(", ")}`);
  const incomplete = release.assets.filter((asset) => asset.state !== "uploaded").map((asset) => `${asset.name} (${asset.state})`);
  if (incomplete.length > 0) problems.push(`not fully uploaded: ${incomplete.join(", ")}`);
  return check("assets", `${base}/releases/tag/${release.tag}`, problems, `${names.length} assets`);
}

async function releaseChecks(input: FeedMonitorInput, release: PipelineRelease, feedName: string, manifest: { info: UpdateInfo; text: string }): Promise<PublishedCheck[]> {
  const { owner, repo, http } = input;
  const base = `https://github.com/${owner}/${repo}`;
  const download = `${base}/releases/download/${release.tag}`;
  const version = formatVersion(release.version);
  const installer = installerNameFor(version);
  const expectedSize = manifest.info.files[0].size;
  const checks: PublishedCheck[] = [assetListCheck(base, release)];

  const otherFeed = feedName === ALPHA_FEED_NAME ? STABLE_FEED_NAME : ALPHA_FEED_NAME;
  const copyUrl = `${download}/${otherFeed}`;
  const copy = await http.text(copyUrl, "*/*");
  checks.push(
    check(
      "feed-copy",
      copyUrl,
      copy.status !== 200 ? [statusText(copy.status, copy.body)] : copy.body === manifest.text ? [] : [`${otherFeed} differs from ${feedName}`],
      `${otherFeed} is byte-identical to ${feedName}`
    )
  );

  const installerUrl = `${download}/${installer}`;
  const listedSize = release.assets.find((asset) => asset.name === installer)?.size ?? null;
  const reachable = await http.size(installerUrl);
  const sizeProblems: string[] = [];
  if (reachable.status !== 200 && reachable.status !== 206) sizeProblems.push(statusText(reachable.status));
  else if (reachable.size !== expectedSize) sizeProblems.push(`served ${reachable.size ?? "an unknown number of"} bytes, the manifest says ${expectedSize}`);
  if (listedSize !== null && listedSize !== expectedSize) sizeProblems.push(`release asset is ${listedSize} bytes, the manifest says ${expectedSize}`);
  checks.push(check("installer", installerUrl, sizeProblems, `downloadable, ${expectedSize} bytes`));

  const signingUrl = `${download}/${SIGNING_MANIFEST_NAME}`;
  const signingResponse = await http.text(signingUrl, "*/*");
  let blockMap: { sha512: string; size: number } | null = null;
  if (signingResponse.status !== 200) {
    checks.push(check("signing", signingUrl, [statusText(signingResponse.status, signingResponse.body)], ""));
  } else {
    let raw: unknown = null;
    try {
      raw = JSON.parse(signingResponse.body);
    } catch {
      raw = null;
    }
    const manifestResult = raw === null ? null : validateSigningManifest(raw);
    if (manifestResult === null) checks.push(check("signing", signingUrl, ["signing.json is not JSON"], ""));
    else if (!manifestResult.ok) checks.push(check("signing", signingUrl, manifestResult.errors, ""));
    else {
      const signing = manifestResult.value;
      blockMap = signing.blockMap;
      const problems: string[] = [];
      if (signing.mode !== "signpath" || !signing.production) problems.push(`not a production signpath manifest (mode ${signing.mode}, production ${signing.production})`);
      if (signing.version !== version) problems.push(`version ${signing.version}, expected ${version}`);
      if (signing.sourceSha !== release.sourceSha) problems.push(`sourceSha ${signing.sourceSha}, the release marker says ${release.sourceSha}`);
      const installerRecord = signing.files.find((file) => file.path === installer);
      if (!installerRecord) problems.push(`does not list ${installer}`);
      else if (installerRecord.sha512 !== manifest.info.sha512) problems.push(`records another installer sha512 than ${feedName}`);
      checks.push(check("signing", signingUrl, problems, `production, signed by ${signing.publisher ?? "?"}, installer sha512 matches ${feedName}`));
    }
  }

  const blockMapUrl = `${download}/${blockMapNameOf(installer)}`;
  const blockMapResponse = await http.digest(blockMapUrl);
  const blockMapProblems: string[] = [];
  if (blockMapResponse.status !== 200) blockMapProblems.push(statusText(blockMapResponse.status));
  else if (blockMap === null) blockMapProblems.push("no digest in signing.json to compare with");
  else {
    if (blockMapResponse.sha512 !== blockMap.sha512) blockMapProblems.push("sha512 differs from signing.json");
    if (blockMapResponse.size !== blockMap.size) blockMapProblems.push(`${blockMapResponse.size} bytes, signing.json says ${blockMap.size}`);
  }
  checks.push(check("blockmap", blockMapUrl, blockMapProblems, `${blockMapResponse.size} bytes, sha512 matches signing.json`));

  if (input.verifyInstallerDigest) {
    const full = await http.digest(installerUrl);
    const problems: string[] = [];
    if (full.status !== 200) problems.push(statusText(full.status));
    else {
      if (full.sha512 !== manifest.info.sha512) problems.push(`sha512 differs from ${feedName}`);
      if (full.size !== expectedSize) problems.push(`${full.size} bytes, expected ${expectedSize}`);
    }
    checks.push(check("installer-digest", installerUrl, problems, `sha512 matches ${feedName}`));
  }
  return checks;
}

function channelReport(channel: FeedChannel, release: PipelineRelease, checks: PublishedCheck[]): ChannelReport {
  return {
    channel,
    status: checks.every((entry) => entry.ok) ? "healthy" : "failed",
    tag: release.tag,
    sourceSha: release.sourceSha,
    notice: null,
    checks
  };
}

async function stableChannel(input: FeedMonitorInput, pipeline: PipelineRelease[]): Promise<ChannelReport> {
  const { owner, repo, http } = input;
  const base = `https://github.com/${owner}/${repo}`;
  const latestUrl = `${base}/releases/latest`;
  const latest = await http.text(latestUrl, "application/json");
  const latestTag = latest.status === 200 ? parseJsonObject(latest.body)?.tag_name : undefined;
  const resolved = typeof latestTag === "string" ? latestTag : statusText(latest.status, latest.body);
  const target = highest(pipeline.filter((release) => release.version.channel === "stable"));
  if (!target) {
    return {
      channel: "stable",
      status: "not-yet",
      tag: null,
      sourceSha: null,
      notice: `no pipeline-built stable release exists; ${latestUrl} resolves to ${resolved}, which is not a pipeline-built release, so stable-channel clients see no update until the first pipeline-built stable is published`,
      checks: []
    };
  }
  const checks: PublishedCheck[] = [
    check("latest-release", latestUrl, latestTag === target.tag ? [] : [`stable clients resolve ${resolved}, expected the highest pipeline-built stable ${target.tag}`], `stable clients resolve ${target.tag}`)
  ];
  const manifest = await manifestCheck(http, `${base}/releases/latest/download/${STABLE_FEED_NAME}`, target);
  checks.push(manifest.result);
  if (manifest.result.ok && manifest.info && manifest.text) checks.push(...(await releaseChecks(input, target, STABLE_FEED_NAME, { info: manifest.info, text: manifest.text })));
  return channelReport("stable", target, checks);
}

async function alphaChannel(input: FeedMonitorInput, pipeline: PipelineRelease[]): Promise<ChannelReport> {
  const { owner, repo, http } = input;
  const base = `https://github.com/${owner}/${repo}`;
  const atomUrl = `${base}/releases.atom`;
  const atom = await http.text(atomUrl, "application/atom+xml, application/xml, */*");
  const resolved = atom.status === 200 ? alphaClientTag(atom.body) : null;
  const target = highest(pipeline);
  if (!target) {
    return {
      channel: "alpha",
      status: "not-yet",
      tag: null,
      sourceSha: null,
      notice: `no pipeline-built release exists; ${atomUrl} resolves alpha clients to ${resolved ?? statusText(atom.status, atom.body)}, which is not a pipeline-built release, so alpha-channel clients see no update until the first pipeline-built release is published`,
      checks: []
    };
  }
  const atomProblems =
    atom.status !== 200
      ? [statusText(atom.status, atom.body)]
      : resolved === target.tag
        ? []
        : [`alpha clients resolve ${resolved ?? "no release"} from the releases feed, expected the highest pipeline-built release ${target.tag}`];
  const checks: PublishedCheck[] = [check("atom-feed", atomUrl, atomProblems, `alpha clients resolve ${target.tag}`)];
  const manifest = await manifestCheck(http, `${base}/releases/download/${target.tag}/${ALPHA_FEED_NAME}`, target);
  checks.push(manifest.result);
  if (manifest.result.ok && manifest.info && manifest.text) checks.push(...(await releaseChecks(input, target, ALPHA_FEED_NAME, { info: manifest.info, text: manifest.text })));
  return channelReport("alpha", target, checks);
}

function channelSummary(report: ChannelReport): string {
  if (report.status === "not-yet") return `${report.channel}: no pipeline-built release yet`;
  const where = `${report.tag} (${shortSha(report.sourceSha ?? "")})`;
  if (report.status === "healthy") return `${report.channel} ${where} ok`;
  return `${report.channel} ${where} FAILED ${report.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(", ")}`;
}

export async function monitorUpdateFeed(input: FeedMonitorInput): Promise<FeedMonitorReport> {
  const listingUrl = `https://api.github.com/repos/${input.owner}/${input.repo}/releases?per_page=100`;
  const listingResponse = await input.http.api(listingUrl);
  const pipeline = listingResponse.status === 200 ? pipelineReleasesOf(listingResponse.body) : null;
  if (pipeline === null) {
    const detail = listingResponse.status === 200 ? "the releases listing is not a JSON array" : statusText(listingResponse.status, listingResponse.body);
    return { ok: false, attempts: 1, listing: check("listing", listingUrl, [detail], ""), channels: [], summary: `Update feed check FAILED: cannot list releases (${detail})` };
  }
  const listing = check("listing", listingUrl, [], `${pipeline.length} pipeline-built release(s)`);
  const channels = [await stableChannel(input, pipeline), await alphaChannel(input, pipeline)];
  const ok = channels.every((report) => report.status !== "failed");
  return { ok, attempts: 1, listing, channels, summary: `Update feed ${ok ? "ok" : "FAILED"}: ${channels.map(channelSummary).join("; ")}` };
}

export async function monitorUpdateFeedWithRetries(input: FeedMonitorInput, retry: MonitorRetryOptions): Promise<FeedMonitorReport> {
  let report = await monitorUpdateFeed(input);
  for (let attempt = 2; attempt <= retry.attempts && !report.ok; attempt += 1) {
    await retry.sleep(retry.initialDelayMs * 2 ** (attempt - 2));
    report = { ...(await monitorUpdateFeed(input)), attempts: attempt };
  }
  return report;
}
