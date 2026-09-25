import type { ReleasePlan } from "./planValidation.ts";
import { ALPHA_FEED_NAME, SIGNING_MANIFEST_NAME, STABLE_FEED_NAME, installerNameFor, publishableAssetNames } from "./releaseAssets.ts";
import { blockMapNameOf, validateSigningManifest } from "./signingManifest.ts";
import { parseUpdateInfo } from "./updateInfoYaml.ts";

export interface AnonymousHttp {
  text(url: string, accept: string): Promise<{ status: number; body: string }>;
  digest(url: string): Promise<{ status: number; sha512: string; size: number }>;
}

export interface PublishedCheck {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
}

export interface PublishedCheckInput {
  plan: ReleasePlan;
  owner: string;
  repo: string;
  http: AnonymousHttp;
}

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface PublishedCheckReport {
  ok: boolean;
  attempts: number;
  checks: PublishedCheck[];
}

const JSON_ACCEPT = "application/json";
const API_ACCEPT = "application/vnd.github+json";
const TEXT_ACCEPT = "*/*";

export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function check(name: string, url: string, problems: string[], okDetail: string): PublishedCheck {
  return { name, url, ok: problems.length === 0, detail: problems.length === 0 ? okDetail : problems.join("; ") };
}

async function releaseApiCheck({ plan, owner, repo, http }: PublishedCheckInput): Promise<PublishedCheck> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${plan.tag}`;
  const response = await http.text(url, API_ACCEPT);
  const release = parseJsonObject(response.body);
  if (response.status !== 200 || !release) return check("release", url, [`HTTP ${response.status}`], "");
  const problems: string[] = [];
  if (release.draft !== false) problems.push("the release is a draft");
  if (release.prerelease !== plan.prerelease) problems.push(`prerelease is ${String(release.prerelease)}, expected ${plan.prerelease}`);
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => String((asset as { name?: unknown }).name)) : [];
  const missing = publishableAssetNames(plan).filter((name) => !assets.includes(name));
  if (missing.length > 0) problems.push(`missing assets: ${missing.join(", ")}`);
  const extra = assets.filter((name) => !publishableAssetNames(plan).includes(name));
  if (extra.length > 0) problems.push(`unexpected assets: ${extra.join(", ")}`);
  return check("release", url, problems, `public, prerelease=${plan.prerelease}, ${assets.length} assets`);
}

async function latestReleaseCheck({ plan, owner, repo, http }: PublishedCheckInput): Promise<PublishedCheck> {
  const url = `https://github.com/${owner}/${repo}/releases/latest`;
  const response = await http.text(url, JSON_ACCEPT);
  const tag = response.status === 200 ? parseJsonObject(response.body)?.tag_name : undefined;
  if (plan.channel === "stable") {
    const problems = tag === plan.tag ? [] : [`stable clients resolve the latest release to ${String(tag ?? `HTTP ${response.status}`)}, expected ${plan.tag}`];
    return check("latest-release", url, problems, `stable clients resolve ${plan.tag}`);
  }
  const problems = tag === plan.tag ? [`alpha ${plan.tag} is marked as the latest release, so stable clients would see it`] : [];
  if (response.status !== 200 && response.status !== 404) problems.push(`HTTP ${response.status}`);
  return check("latest-release", url, problems, `latest release stays ${String(tag ?? "unset")}`);
}

async function atomFeedCheck({ plan, owner, repo, http }: PublishedCheckInput): Promise<PublishedCheck> {
  const url = `https://github.com/${owner}/${repo}/releases.atom`;
  const response = await http.text(url, TEXT_ACCEPT);
  if (response.status !== 200) return check("atom-feed", url, [`HTTP ${response.status}`], "");
  const listed = [...new Set([...response.body.matchAll(/\/releases\/tag\/([^"'<>\s]+)/g)].map((match) => match[1]))];
  if (listed.includes(plan.tag)) return check("atom-feed", url, [], `${plan.tag} listed`);
  const recentUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${Math.max(listed.length, 1)}`;
  const recent = await http.text(recentUrl, API_ACCEPT);
  let recentTags: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(recent.body);
    if (recent.status === 200 && Array.isArray(parsed)) recentTags = parsed.map((entry) => String((entry as { tag_name?: unknown }).tag_name));
  } catch {
    recentTags = null;
  }
  if (recentTags === null) return check("atom-feed", url, [`${plan.tag} is not in the feed and ${recentUrl} answered HTTP ${recent.status}`], "");
  if (recentTags.includes(plan.tag)) {
    return check("atom-feed", url, [`${plan.tag} is among the ${Math.max(listed.length, 1)} most recent releases but not in the feed yet`], "");
  }
  return check("atom-feed", url, [], `${plan.tag} is older than the ${listed.length} releases the feed lists; covered by the release and channel-manifest checks`);
}

async function channelManifestCheck(input: PublishedCheckInput): Promise<{ result: PublishedCheck; sha512: string | null; size: number | null }> {
  const { plan, owner, repo, http } = input;
  const url =
    plan.channel === "stable"
      ? `https://github.com/${owner}/${repo}/releases/latest/download/${STABLE_FEED_NAME}`
      : `https://github.com/${owner}/${repo}/releases/download/${plan.tag}/${ALPHA_FEED_NAME}`;
  const response = await http.text(url, TEXT_ACCEPT);
  if (response.status !== 200) return { result: check("channel-manifest", url, [`HTTP ${response.status}`], ""), sha512: null, size: null };
  try {
    const info = parseUpdateInfo(response.body);
    const problems: string[] = [];
    if (info.version !== plan.version) problems.push(`advertises ${info.version}, expected ${plan.version}`);
    if (info.path !== installerNameFor(plan.version)) problems.push(`points at ${info.path}`);
    return { result: check("channel-manifest", url, problems, `advertises ${plan.version}`), sha512: info.sha512, size: info.files[0].size };
  } catch (error: unknown) {
    return { result: check("channel-manifest", url, [error instanceof Error ? error.message : String(error)], ""), sha512: null, size: null };
  }
}

async function digestCheck(http: AnonymousHttp, name: string, url: string, expected: { sha512: string | null; size: number | null }): Promise<PublishedCheck> {
  const response = await http.digest(url);
  if (response.status !== 200) return check(name, url, [`HTTP ${response.status}`], "");
  const problems: string[] = [];
  if (expected.sha512 === null || expected.size === null) problems.push("no expected digest to compare with");
  else {
    if (response.sha512 !== expected.sha512) problems.push("sha512 differs from the published metadata");
    if (response.size !== expected.size) problems.push(`${response.size} bytes, expected ${expected.size}`);
  }
  return check(name, url, problems, `${response.size} bytes, sha512 matches`);
}

async function signingCheck({ plan, owner, repo, http }: PublishedCheckInput): Promise<{ result: PublishedCheck; blockMap: { sha512: string; size: number } | null }> {
  const url = `https://github.com/${owner}/${repo}/releases/download/${plan.tag}/${SIGNING_MANIFEST_NAME}`;
  const response = await http.text(url, TEXT_ACCEPT);
  if (response.status !== 200) return { result: check("signing", url, [`HTTP ${response.status}`], ""), blockMap: null };
  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch {
    return { result: check("signing", url, ["signing.json is not JSON"], ""), blockMap: null };
  }
  const manifest = validateSigningManifest(raw);
  if (!manifest.ok) return { result: check("signing", url, manifest.errors, ""), blockMap: null };
  const problems: string[] = [];
  if (!manifest.value.production || manifest.value.mode !== "signpath") problems.push(`not a production signpath manifest (mode ${manifest.value.mode})`);
  if (manifest.value.version !== plan.version) problems.push(`version ${manifest.value.version}, expected ${plan.version}`);
  if (manifest.value.sourceSha !== plan.sourceSha) problems.push(`sourceSha ${manifest.value.sourceSha}, expected ${plan.sourceSha}`);
  return { result: check("signing", url, problems, `signed by ${manifest.value.publisher ?? "?"}, production`), blockMap: manifest.value.blockMap };
}

export async function checkPublishedRelease(input: PublishedCheckInput): Promise<PublishedCheck[]> {
  const { plan, owner, repo, http } = input;
  const installer = installerNameFor(plan.version);
  const base = `https://github.com/${owner}/${repo}/releases/download/${plan.tag}`;
  const manifest = await channelManifestCheck(input);
  const signing = await signingCheck(input);
  return [
    await releaseApiCheck(input),
    await latestReleaseCheck(input),
    await atomFeedCheck(input),
    manifest.result,
    await digestCheck(http, "installer", `${base}/${installer}`, { sha512: manifest.sha512, size: manifest.size }),
    signing.result,
    await digestCheck(http, "blockmap", `${base}/${blockMapNameOf(installer)}`, { sha512: signing.blockMap?.sha512 ?? null, size: signing.blockMap?.size ?? null })
  ];
}

export async function checkPublishedReleaseWithRetries(input: PublishedCheckInput, retry: RetryOptions): Promise<PublishedCheckReport> {
  let checks: PublishedCheck[] = [];
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    checks = await checkPublishedRelease(input);
    if (checks.every((entry) => entry.ok)) return { ok: true, attempts: attempt, checks };
    if (attempt < retry.attempts) await retry.sleep(retry.delayMs);
  }
  return { ok: false, attempts: retry.attempts, checks };
}
