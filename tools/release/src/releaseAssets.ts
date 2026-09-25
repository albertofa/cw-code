import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type ReleasePlan, validatePlanShape } from "./planValidation.ts";
import { exists, sha512Base64 } from "./rehash.ts";
import { verifyReleaseSet } from "./releaseSet.ts";
import {
  type SigningFileRecord,
  type SigningManifest,
  blockMapNameOf,
  isInstallerPath,
  provenanceMismatches,
  validateSigningManifest
} from "./signingManifest.ts";
import { normalizeReleaseNotes, parseUpdateInfo, readReleaseText, withReleaseText } from "./updateInfoYaml.ts";

export const SIGNING_MANIFEST_NAME = "signing.json";
export const STABLE_FEED_NAME = "latest.yml";
export const ALPHA_FEED_NAME = "alpha.yml";

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
  expectedPublisher?: string;
  unpackedRoot?: string;
}

export function installerNameFor(version: string): string {
  return `cw-code-Setup-${version}-x64.exe`;
}

export function publishableAssetNames(plan: Pick<ReleasePlan, "version" | "channel">): string[] {
  const installer = installerNameFor(plan.version);
  const feeds = plan.channel === "alpha" ? [STABLE_FEED_NAME, ALPHA_FEED_NAME] : [ALPHA_FEED_NAME, STABLE_FEED_NAME];
  return [installer, blockMapNameOf(installer), SIGNING_MANIFEST_NAME, ...feeds];
}

export function isFeedManifest(name: string): boolean {
  return name === STABLE_FEED_NAME || name === ALPHA_FEED_NAME;
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

function feedErrors(text: string, plan: ReleasePlan, installer: ReleaseAssetFile | undefined): string[] {
  let info: ReturnType<typeof parseUpdateInfo>;
  try {
    info = parseUpdateInfo(text);
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
  const release = readReleaseText(text);
  if (release.releaseName !== plan.tag) {
    errors.push(`${STABLE_FEED_NAME} releaseName ${JSON.stringify(release.releaseName)} must be ${plan.tag}, or clients fall back to another release's title`);
  }
  if (release.releaseNotes !== normalizeReleaseNotes(plan.notes)) {
    errors.push(`${STABLE_FEED_NAME} releaseNotes differ from the plan notes, or clients fall back to another release's notes`);
  }
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
  if (options.requireProduction && (!manifest.production || manifest.mode !== "signpath")) {
    errors.push(`signing.json is not a production signpath manifest (mode ${manifest.mode}, production ${manifest.production}); it can never be published`);
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

export async function stageReleaseSet(from: string, to: string, plan: unknown): Promise<string[]> {
  const shape = validatePlanShape(plan);
  if (!shape.ok) throw new Error(`Invalid plan: ${shape.errors.join("; ")}`);
  if (await exists(to)) {
    if ((await readdir(to)).length > 0) throw new Error(`${to} already exists and is not empty; stage into a fresh directory`);
  }
  const { plan: validPlan } = shape;
  const latestPath = join(from, STABLE_FEED_NAME);
  if (!(await exists(latestPath))) throw new Error(`${STABLE_FEED_NAME} is missing from ${from}`);
  const latest = await readFile(latestPath);
  const alphaPath = join(from, ALPHA_FEED_NAME);
  if ((await exists(alphaPath)) && !latest.equals(await readFile(alphaPath))) {
    throw new Error(`${ALPHA_FEED_NAME} in ${from} differs from ${STABLE_FEED_NAME}; the channel files must describe the same installer`);
  }
  const feed = withReleaseText(latest.toString("utf8"), { releaseName: validPlan.tag, releaseNotes: validPlan.notes });

  await mkdir(to, { recursive: true });
  const staged: string[] = [];
  for (const name of publishableAssetNames(validPlan)) {
    if (name === STABLE_FEED_NAME || name === ALPHA_FEED_NAME) {
      await writeFile(join(to, name), feed, "utf8");
      staged.push(`${name} (${STABLE_FEED_NAME} with releaseName and releaseNotes from the plan)`);
      continue;
    }
    const source = join(from, name);
    if (!(await exists(source))) throw new Error(`${name} is missing from ${from}`);
    await copyFile(source, join(to, name));
    staged.push(name);
  }
  return staged;
}
