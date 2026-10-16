import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type ReleasePlan, validatePlanShape } from "./planValidation.ts";
import { exists, sha512Base64 } from "./rehash.ts";
import { verifyReleaseSet } from "./releaseSet.ts";
import {
  type SigningFileRecord,
  type SigningManifest,
  type SigningMode,
  blockMapNameOf,
  isInstallerPath,
  provenanceMismatches,
  validateSigningManifest
} from "./signingManifest.ts";
import { normalizeReleaseNotes, parseSingleInstallerUpdateInfo, parseUpdateInfo, readReleaseText, withReleaseText } from "./updateInfoYaml.ts";

export const SIGNING_MANIFEST_NAME = "signing.json";
export const STABLE_FEED_NAME = "latest.yml";
export const ALPHA_FEED_NAME = "alpha.yml";
export const LINUX_STABLE_FEED_NAME = "latest-linux.yml";
export const LINUX_ALPHA_FEED_NAME = "alpha-linux.yml";

export interface ReleaseAssetFile {
  name: string;
  size: number;
  sha512: string;
}

export interface ReleaseAssetsReport {
  ok: boolean;
  version: string | null;
  channel: string | null;
  tag: string | null;
  sourceSha: string | null;
  installer: string | null;
  signingMode: string | null;
  production: boolean | null;
  publisher: string | null;
  installerSignature: Pick<SigningFileRecord, "status" | "subject" | "timestamped"> | null;
  assets: ReleaseAssetFile[];
  errors: string[];
}

export interface ValidateReleaseAssetsOptions {
  dir: string;
  plan: unknown;
  signing: unknown;
  runId: string;
  requireProduction: boolean;
  expectedSigningMode?: SigningMode;
  expectedPublisher?: string;
  unpackedRoot?: string;
}

export function installerNameFor(version: string): string {
  return `cw-code-Setup-${version}-x64.exe`;
}

export function appImageNameFor(version: string): string {
  return `cw-code-${version}-x86_64.AppImage`;
}

export function debNameFor(version: string): string {
  return `cw-code-${version}-amd64.deb`;
}

export function linuxAssetNames(version: string): string[] {
  return [appImageNameFor(version), debNameFor(version), LINUX_STABLE_FEED_NAME, LINUX_ALPHA_FEED_NAME];
}

export function publishableAssetNames(plan: Pick<ReleasePlan, "version" | "channel">): string[] {
  const installer = installerNameFor(plan.version);
  const alpha = plan.channel === "alpha";
  const otherFeeds = alpha ? [STABLE_FEED_NAME, LINUX_STABLE_FEED_NAME] : [ALPHA_FEED_NAME, LINUX_ALPHA_FEED_NAME];
  const ownFeeds = alpha ? [ALPHA_FEED_NAME, LINUX_ALPHA_FEED_NAME] : [STABLE_FEED_NAME, LINUX_STABLE_FEED_NAME];
  return [installer, blockMapNameOf(installer), SIGNING_MANIFEST_NAME, appImageNameFor(plan.version), debNameFor(plan.version), ...otherFeeds, ...ownFeeds];
}

export function isFeedManifest(name: string): boolean {
  return name === STABLE_FEED_NAME || name === ALPHA_FEED_NAME || name === LINUX_STABLE_FEED_NAME || name === LINUX_ALPHA_FEED_NAME;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function describeFile(dir: string, name: string): Promise<ReleaseAssetFile> {
  const path = join(dir, name);
  const [info, sha512] = await Promise.all([stat(path), sha512Base64(path)]);
  return { name, size: info.size, sha512 };
}

async function listingErrors(dir: string, expected: string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const errors: string[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    names.add(entry.name);
    if (!expected.includes(entry.name)) errors.push(`unexpected ${entry.isDirectory() ? "directory" : "file"} ${entry.name} in the release set`);
    else if (!entry.isFile()) errors.push(`${entry.name} must be a regular file`);
  }
  for (const name of expected) {
    if (!names.has(name)) errors.push(`${name} is missing from the release set`);
  }
  return errors;
}

function releaseTextErrors(feedName: string, text: string, plan: ReleasePlan): string[] {
  const errors: string[] = [];
  const release = readReleaseText(text);
  if (release.releaseName !== plan.tag) {
    errors.push(`${feedName} releaseName ${JSON.stringify(release.releaseName)} must be ${plan.tag}, or clients fall back to another release's title`);
  }
  if (release.releaseNotes !== normalizeReleaseNotes(plan.notes)) {
    errors.push(`${feedName} releaseNotes differ from the plan notes, or clients fall back to another release's notes`);
  }
  return errors;
}

function linuxFeedErrors(text: string, plan: ReleasePlan, appImage: ReleaseAssetFile | undefined, deb: ReleaseAssetFile | undefined): string[] {
  const feedName = LINUX_STABLE_FEED_NAME;
  let info: ReturnType<typeof parseUpdateInfo>;
  try {
    info = parseUpdateInfo(text);
  } catch (error: unknown) {
    return [`${feedName}: ${message(error)}`];
  }
  const errors: string[] = [];
  const expected = [
    { name: appImageNameFor(plan.version), bytes: appImage },
    { name: debNameFor(plan.version), bytes: deb }
  ];
  if (info.version !== plan.version) errors.push(`${feedName} version ${info.version} differs from the plan version ${plan.version}`);
  if (info.path !== expected[0].name) errors.push(`${feedName} path ${info.path} must be ${expected[0].name}`);
  if (info.files.length !== expected.length || info.files.some((file, index) => file.url !== expected[index].name)) {
    errors.push(`${feedName} files must be exactly ${expected.map((entry) => entry.name).join(", ")}, got ${info.files.map((file) => file.url).join(", ")}`);
  } else {
    expected.forEach(({ name, bytes }, index) => {
      const file = info.files[index];
      if (!bytes) return;
      if (file.sha512 !== bytes.sha512) errors.push(`${feedName} sha512 for ${name} does not match its bytes`);
      if (file.size !== bytes.size) errors.push(`${feedName} size ${file.size} for ${name} does not match its bytes (${bytes.size})`);
    });
  }
  if (appImage && info.sha512 !== appImage.sha512) errors.push(`${feedName} top-level sha512 does not match the AppImage bytes`);
  errors.push(...releaseTextErrors(feedName, text, plan));
  return errors;
}

function feedErrors(text: string, plan: ReleasePlan, installer: ReleaseAssetFile | undefined): string[] {
  let info: ReturnType<typeof parseUpdateInfo>;
  try {
    info = parseSingleInstallerUpdateInfo(text);
  } catch (error: unknown) {
    return [`${STABLE_FEED_NAME}: ${message(error)}`];
  }
  const errors: string[] = [];
  const expectedInstaller = installerNameFor(plan.version);
  if (info.version !== plan.version) errors.push(`${STABLE_FEED_NAME} version ${info.version} differs from the plan version ${plan.version}`);
  if (info.path !== expectedInstaller) errors.push(`${STABLE_FEED_NAME} path ${info.path} must be ${expectedInstaller}`);
  const [file] = info.files;
  if (file.url !== expectedInstaller) errors.push(`${STABLE_FEED_NAME} files[0].url ${file.url} must be ${expectedInstaller}`);
  if (info.sha512 !== file.sha512) errors.push(`${STABLE_FEED_NAME} top-level sha512 differs from files[0].sha512`);
  if (installer) {
    if (file.sha512 !== installer.sha512) errors.push(`${STABLE_FEED_NAME} sha512 does not match the installer bytes`);
    if (file.size !== installer.size) errors.push(`${STABLE_FEED_NAME} size ${file.size} does not match the installer (${installer.size} bytes)`);
  }
  errors.push(...releaseTextErrors(STABLE_FEED_NAME, text, plan));
  return errors;
}

export function blockMapShapeErrors(bytes: Buffer, installerSize: number | null): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch (error: unknown) {
    return [`blockmap is not gzip-compressed JSON: ${message(error)}`];
  }
  const value = parsed as { version?: unknown; files?: unknown };
  if (value.version !== "2") return [`blockmap version must be "2", got ${JSON.stringify(value.version)}`];
  if (!Array.isArray(value.files) || value.files.length !== 1) return ["blockmap must describe exactly one file"];
  const file = value.files[0] as { checksums?: unknown; sizes?: unknown };
  if (!Array.isArray(file.checksums) || !Array.isArray(file.sizes) || file.checksums.length !== file.sizes.length || file.sizes.length === 0) {
    return ["blockmap checksums and sizes must be non-empty arrays of equal length"];
  }
  const total = (file.sizes as unknown[]).reduce<number>((sum, size) => sum + (typeof size === "number" ? size : Number.NaN), 0);
  if (installerSize !== null && total !== installerSize) return [`blockmap covers ${total} bytes but the installer has ${installerSize}`];
  return [];
}

function signingErrors(manifest: SigningManifest, plan: ReleasePlan, options: ValidateReleaseAssetsOptions, assets: Map<string, ReleaseAssetFile>): string[] {
  const errors = provenanceMismatches(manifest, { version: plan.version, sourceSha: plan.sourceSha, runId: options.runId });
  if (options.requireProduction && !manifest.production) {
    errors.push(`signing.json is not a production manifest (mode ${manifest.mode}); it can never be published`);
  }
  if (options.expectedSigningMode !== undefined && manifest.mode !== options.expectedSigningMode) {
    errors.push(`signing.json mode ${manifest.mode} differs from the planned signing mode ${options.expectedSigningMode}`);
  }
  if (options.expectedPublisher !== undefined && manifest.publisher !== options.expectedPublisher) {
    errors.push(`signing.json publisher ${JSON.stringify(manifest.publisher)} differs from the expected ${JSON.stringify(options.expectedPublisher)}`);
  }
  const installerName = installerNameFor(plan.version);
  const signedInstaller = manifest.files.find((file) => isInstallerPath(file.path));
  const installer = assets.get(installerName);
  if (signedInstaller?.path !== installerName) {
    errors.push(`signing.json installer ${JSON.stringify(signedInstaller?.path)} must be ${installerName}`);
  } else if (installer && signedInstaller.sha512 !== installer.sha512) {
    errors.push(`${installerName} bytes differ from the installer recorded in signing.json`);
  }
  const blockMap = assets.get(blockMapNameOf(installerName));
  if (blockMap && (manifest.blockMap.sha512 !== blockMap.sha512 || manifest.blockMap.size !== blockMap.size)) {
    errors.push(`${blockMap.name} bytes differ from the blockmap recorded in signing.json`);
  }
  return errors;
}

function emptyReport(errors: string[]): ReleaseAssetsReport {
  return {
    ok: false,
    version: null,
    channel: null,
    tag: null,
    sourceSha: null,
    installer: null,
    signingMode: null,
    production: null,
    publisher: null,
    installerSignature: null,
    assets: [],
    errors
  };
}

export async function validateReleaseAssets(options: ValidateReleaseAssetsOptions): Promise<ReleaseAssetsReport> {
  const shape = validatePlanShape(options.plan);
  if (!shape.ok) return emptyReport(shape.errors.map((error) => `plan: ${error}`));
  const { plan } = shape;
  if (!/^\d+$/.test(options.runId)) return emptyReport([`run id must be numeric, got ${JSON.stringify(options.runId)}`]);

  const expected = publishableAssetNames(plan);
  const errors = await listingErrors(options.dir, expected);
  const assets = new Map<string, ReleaseAssetFile>();
  for (const name of expected) {
    if (await exists(join(options.dir, name))) assets.set(name, await describeFile(options.dir, name));
  }

  const installerName = installerNameFor(plan.version);
  const installer = assets.get(installerName);
  if (assets.has(STABLE_FEED_NAME)) {
    const latest = await readFile(join(options.dir, STABLE_FEED_NAME));
    errors.push(...feedErrors(latest.toString("utf8"), plan, installer));
    if (assets.has(ALPHA_FEED_NAME) && !latest.equals(await readFile(join(options.dir, ALPHA_FEED_NAME)))) {
      errors.push(`${ALPHA_FEED_NAME} must be a byte copy of ${STABLE_FEED_NAME}`);
    }
  }
  if (assets.has(LINUX_STABLE_FEED_NAME)) {
    const latestLinux = await readFile(join(options.dir, LINUX_STABLE_FEED_NAME));
    errors.push(...linuxFeedErrors(latestLinux.toString("utf8"), plan, assets.get(appImageNameFor(plan.version)), assets.get(debNameFor(plan.version))));
    if (assets.has(LINUX_ALPHA_FEED_NAME) && !latestLinux.equals(await readFile(join(options.dir, LINUX_ALPHA_FEED_NAME)))) {
      errors.push(`${LINUX_ALPHA_FEED_NAME} must be a byte copy of ${LINUX_STABLE_FEED_NAME}`);
    }
  }
  const blockMapName = blockMapNameOf(installerName);
  if (assets.has(blockMapName)) {
    errors.push(...blockMapShapeErrors(await readFile(join(options.dir, blockMapName)), installer?.size ?? null));
  }

  const report: ReleaseAssetsReport = {
    ok: false,
    version: plan.version,
    channel: plan.channel,
    tag: plan.tag,
    sourceSha: plan.sourceSha,
    installer: installerName,
    signingMode: null,
    production: null,
    publisher: null,
    installerSignature: null,
    assets: expected.flatMap((name) => assets.get(name) ?? []),
    errors
  };

  const signing = validateSigningManifest(options.signing);
  if (!signing.ok) {
    errors.push(...signing.errors.map((error) => `signing.json: ${error}`));
  } else {
    const manifest = signing.value;
    report.signingMode = manifest.mode;
    report.production = manifest.production;
    report.publisher = manifest.publisher;
    const signedInstaller = manifest.files.find((file) => file.path === installerName);
    report.installerSignature = signedInstaller ? { status: signedInstaller.status, subject: signedInstaller.subject, timestamped: signedInstaller.timestamped } : null;
    errors.push(...signingErrors(manifest, plan, options, assets));
    if (options.unpackedRoot !== undefined) {
      errors.push(...(await verifyReleaseSet(options.unpackedRoot, manifest)).map((error) => `full release set: ${error}`));
    }
  }
  report.ok = errors.length === 0;
  return report;
}

interface StagedFeed {
  stableName: string;
  text: string;
}

async function stagedFeed(dir: string, stableName: string, copyName: string, plan: ReleasePlan): Promise<StagedFeed> {
  const stablePath = join(dir, stableName);
  if (!(await exists(stablePath))) throw new Error(`${stableName} is missing from ${dir}`);
  const stable = await readFile(stablePath);
  const copyPath = join(dir, copyName);
  if ((await exists(copyPath)) && !stable.equals(await readFile(copyPath))) {
    throw new Error(`${copyName} in ${dir} differs from ${stableName}; the channel files must describe the same installer`);
  }
  return { stableName, text: withReleaseText(stable.toString("utf8"), { releaseName: plan.tag, releaseNotes: plan.notes }) };
}

export async function stageReleaseSet(from: string, to: string, plan: unknown, linuxFrom: string): Promise<string[]> {
  const shape = validatePlanShape(plan);
  if (!shape.ok) throw new Error(`Invalid plan: ${shape.errors.join("; ")}`);
  if (await exists(to)) {
    if ((await readdir(to)).length > 0) throw new Error(`${to} already exists and is not empty; stage into a fresh directory`);
  }
  const { plan: validPlan } = shape;
  const windowsFeed = await stagedFeed(from, STABLE_FEED_NAME, ALPHA_FEED_NAME, validPlan);
  const linuxFeed = await stagedFeed(linuxFrom, LINUX_STABLE_FEED_NAME, LINUX_ALPHA_FEED_NAME, validPlan);
  const feeds = new Map([
    [STABLE_FEED_NAME, windowsFeed],
    [ALPHA_FEED_NAME, windowsFeed],
    [LINUX_STABLE_FEED_NAME, linuxFeed],
    [LINUX_ALPHA_FEED_NAME, linuxFeed]
  ]);
  const linuxPayload = new Set([appImageNameFor(validPlan.version), debNameFor(validPlan.version)]);

  await mkdir(to, { recursive: true });
  const staged: string[] = [];
  for (const name of publishableAssetNames(validPlan)) {
    const feed = feeds.get(name);
    if (feed) {
      await writeFile(join(to, name), feed.text, "utf8");
      staged.push(`${name} (${feed.stableName} with releaseName and releaseNotes from the plan)`);
      continue;
    }
    const sourceDir = linuxPayload.has(name) ? linuxFrom : from;
    const source = join(sourceDir, name);
    if (!(await exists(source))) throw new Error(`${name} is missing from ${sourceDir}`);
    await copyFile(source, join(to, name));
    staged.push(name);
  }
  return staged;
}
