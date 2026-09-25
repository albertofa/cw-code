import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.ts";
import { loadElectronBuilderBlockMap } from "../blockMapBuilder.ts";
import { createGitHubReleaseClient } from "../gitHubReleaseClient.ts";
import { createGitHubReleaseSource } from "../gitHubReleaseSource.ts";
import { applyVersion, checkSync, DEFAULT_PACKAGE_RELATIVE_PATHS, readPackageVersions, setBase } from "../packageVersions.ts";
import { type ReleasePlan, validatePlanShape } from "../planValidation.ts";
import { createClientHttp } from "../clientHttp.ts";
import { checkPublishedReleaseWithRetries } from "../publishedCheck.ts";
import { FEED_MONITOR_RUNBOOK, monitorUpdateFeedWithRetries } from "../updateFeedMonitor.ts";
import { RECOVERY_RUNBOOK, publishRelease } from "../publishRelease.ts";
import { readReleaseUpdateInfo, rehashRelease, sha512Base64 } from "../rehash.ts";
import { type ReleaseAssetsReport, SIGNING_MANIFEST_NAME, stageReleaseSet, validateReleaseAssets } from "../releaseAssets.ts";
import { buildAlphaPlan, buildStablePromotionPlan, verifyPlan } from "../releasePlan.ts";
import type { ReleaseSource } from "../releaseSource.ts";
import { type RepoInfo, parseGitHubHomepage } from "../repoInfo.ts";
import { type ParsedVersion, FULL_SHA_PATTERN, baseOf, formatVersion, parseVersion, sameBase } from "../semver.ts";
import { verifyReleaseSet } from "../releaseSet.ts";
import {
  blockMapNameOf,
  buildSigningManifest,
  parsePackageInfo,
  parseVerificationReport,
  provenanceMismatches,
  validateSigningManifest
} from "../signingManifest.ts";
import { selectUpgradeBase } from "../upgradeBase.ts";
import { readPublisherNames } from "../updateInfoYaml.ts";
import { parseFaults } from "../feedFaults.ts";
import { validateReleaseFeed } from "../feedManifest.ts";
import { startFeedServer } from "../feedServer.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "../../../../");

function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeGithubOutput(entries: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const blocks = Object.entries(entries).map(([key, value]) => {
    const delimiter = `ghadelim_${randomBytes(8).toString("hex")}`;
    return `${key}<<${delimiter}\n${value}\n${delimiter}`;
  });
  appendFileSync(file, `${blocks.join("\n")}\n`);
}

function requireFullSha(value: string, flag: string): string {
  if (!FULL_SHA_PATTERN.test(value)) {
    fail(`--${flag} must be a full 40-character hex commit SHA, got "${value}"`);
  }
  return value.toLowerCase();
}

function appendStepSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown.trimEnd()}\n`);
}

function annotate(level: "error" | "notice", title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::${level} title=${title}::${escaped}\n`);
}

function annotateError(title: string, message: string): void {
  annotate("error", title, message);
}

function resolveRepo(repoRoot: string): RepoInfo {
  const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { homepage?: string };
  if (!rootPackage.homepage) {
    fail(`Root package.json has no "homepage" field to resolve the GitHub repository from`);
  }
  const info = parseGitHubHomepage(rootPackage.homepage);
  const running = process.env.GITHUB_REPOSITORY;
  if (running && running.toLowerCase() !== `${info.owner}/${info.repo}`.toLowerCase()) {
    fail(`This workflow runs in ${running}, but package.json homepage names ${info.owner}/${info.repo}; refusing to touch another repository`);
  }
  return info;
}

function buildSource(repoRoot: string): ReleaseSource {
  const { owner, repo } = resolveRepo(repoRoot);
  return createGitHubReleaseSource({ owner, repo, cwd: repoRoot });
}

function packagePaths(repoRoot: string): string[] {
  return DEFAULT_PACKAGE_RELATIVE_PATHS.map((relativePath) => resolve(repoRoot, relativePath));
}

async function readDesktopVersion(repoRoot: string): Promise<ParsedVersion> {
  const [entry] = await readPackageVersions([resolve(repoRoot, "apps/desktop/package.json")]);
  return parseVersion(entry.version);
}

async function readDesktopVersionAtSha(source: ReleaseSource, sha: string): Promise<ParsedVersion> {
  const contents = await source.showFile(sha, "apps/desktop/package.json");
  const parsed = JSON.parse(contents) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    fail(`apps/desktop/package.json at ${sha} has no string "version" field`);
  }
  return parseVersion(parsed.version);
}

async function cmdPlan(options: Map<string, string>, repoRoot: string): Promise<void> {
  const channel = options.get("channel");
  if (channel !== "alpha" && channel !== "stable") {
    fail(`--channel must be "alpha" or "stable"`);
  }
  const outPath = options.get("out");
  if (!outPath) fail("--out is required");

  const nowRaw = options.get("now");
  const now = nowRaw ? new Date(nowRaw) : new Date();
  if (Number.isNaN(now.getTime())) fail(`Invalid --now value "${nowRaw}"`);

  const shaOption = options.get("sha");
  const sha = shaOption ? requireFullSha(shaOption, "sha") : undefined;

  const source = buildSource(repoRoot);
  const desktopVersion = sha ? await readDesktopVersionAtSha(source, sha) : await readDesktopVersion(repoRoot);

  if (channel === "stable" && options.has("force")) fail("--force only applies to --channel alpha");
  if (channel === "alpha" && (options.has("candidate") || options.has("expected-sha"))) {
    fail("--candidate and --expected-sha only apply to --channel stable");
  }

  const result =
    channel === "alpha"
      ? await buildAlphaPlan({ source, now, desktopVersion, sha, force: options.get("force") === "true" })
      : await (async () => {
          const candidateInput = options.get("candidate");
          if (!candidateInput) fail("--candidate is required for --channel stable");
          const expectedShaOption = options.get("expected-sha");
          const expectedSha = expectedShaOption ? requireFullSha(expectedShaOption, "expected-sha") : undefined;
          return buildStablePromotionPlan({ source, now, desktopVersion, candidateInput, expectedSha });
        })();

  if (result.status === "skip") {
    const output = { skip: true, reason: result.reason };
    writeFileSync(resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);
    printJson(output);
    writeGithubOutput({ channel, skip: "true", reason: result.reason });
    return;
  }

  writeFileSync(resolve(outPath), `${JSON.stringify(result.plan, null, 2)}\n`);
  printJson(result.plan);
  writeGithubOutput({
    channel: result.plan.channel,
    version: result.plan.version,
    tag: result.plan.tag,
    sha: result.plan.sourceSha,
    skip: "false"
  });
}

async function cmdVerifyPlan(options: Map<string, string>, repoRoot: string): Promise<void> {
  const planPath = options.get("plan");
  if (!planPath) fail("--plan is required");
  const raw: unknown = JSON.parse(readFileSync(resolve(planPath), "utf8"));
  const source = buildSource(repoRoot);
  const result = await verifyPlan(raw, source);
  printJson(result);
  writeGithubOutput({ stale: result.ok ? "false" : "true", resume: result.ok && result.resumeDraft ? "true" : "false" });
  if (!result.ok) process.exitCode = 1;
}

async function cmdApply(options: Map<string, string>, repoRoot: string): Promise<void> {
  const planPath = options.get("plan");
  const versionOption = options.get("version");
  if (!planPath && !versionOption) fail("either --plan or --version is required");
  const paths = packagePaths(repoRoot);

  let version: string;
  if (planPath) {
    const raw: unknown = JSON.parse(readFileSync(resolve(planPath), "utf8"));
    const shape = validatePlanShape(raw);
    if (!shape.ok) fail(`Invalid plan: ${shape.errors.join("; ")}`);
    version = shape.plan.version;
  } else {
    version = versionOption as string;
    const desktopVersion = await readDesktopVersion(repoRoot);
    const parsed = parseVersion(version);
    if (!sameBase(parsed, baseOf(desktopVersion))) {
      fail(
        `--version ${version} is not on the current base ${formatVersion(baseOf(desktopVersion))}; use set-base to change the base via a normal PR, or pass --plan`
      );
    }
  }

  await applyVersion(paths, version);
  printJson({ applied: version, paths });
}

async function cmdSetBase(options: Map<string, string>, repoRoot: string): Promise<void> {
  const version = options.get("version");
  if (!version) fail("--version is required");
  const paths = packagePaths(repoRoot);
  await setBase(paths, version);
  printJson({ base: version, paths });
}

async function cmdCheckSync(repoRoot: string): Promise<void> {
  const result = await checkSync(packagePaths(repoRoot));
  printJson(result);
  if (!result.inSync) process.exitCode = 1;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8").replace(/^﻿/, ""));
}

function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function parseBooleanOption(options: Map<string, string>, name: string): boolean {
  const value = requireOption(options, name);
  if (value !== "true" && value !== "false") fail(`--${name} must be "true" or "false", got "${value}"`);
  return value === "true";
}

async function cmdRehash(options: Map<string, string>, repoRoot: string): Promise<void> {
  const dir = resolve(requireOption(options, "dir"));
  const blockMap = loadElectronBuilderBlockMap(resolve(repoRoot, "apps/desktop/package.json"));
  const result = await rehashRelease(dir, blockMap.build);
  printJson({ ...result, electronBuilder: blockMap.electronBuilderVersion, appBuilderLib: blockMap.appBuilderLibVersion });
}

async function cmdSigningManifest(options: Map<string, string>): Promise<void> {
  const mode = requireOption(options, "mode");
  if (mode !== "signpath" && mode !== "unsigned") fail(`--mode must be "signpath" or "unsigned", got "${mode}"`);
  const production = parseBooleanOption(options, "production");
  const releaseDir = resolve(requireOption(options, "release-dir"));
  const outPath = resolve(requireOption(options, "out"));

  const report = parseVerificationReport(readJsonFile(requireOption(options, "report")));
  if (!report.ok) fail(`Invalid verification report: ${report.errors.join("; ")}`);

  const appUpdatePath = options.get("app-update");
  const appUpdatePublisherNames =
    appUpdatePath && existsSync(resolve(appUpdatePath)) ? readPublisherNames(readFileSync(resolve(appUpdatePath), "utf8")) : null;

  const packageInfo = parsePackageInfo(readJsonFile(requireOption(options, "package-info")));
  if (!packageInfo.ok) fail(`Invalid package-info.json: ${packageInfo.errors.join("; ")}`);

  const updateInfo = await readReleaseUpdateInfo(releaseDir);
  const blockMapName = blockMapNameOf(updateInfo.installerName);
  const blockMapPath = resolve(releaseDir, blockMapName);
  if (!existsSync(blockMapPath)) fail(`${blockMapName} is missing from ${releaseDir}; run rehash first`);
  const result = buildSigningManifest({
    blockMap: { path: blockMapName, sha512: await sha512Base64(blockMapPath), size: statSync(blockMapPath).size },
    mode,
    production,
    publisher: options.get("publisher") ?? null,
    expected: {
      version: requireOption(options, "version"),
      sourceSha: requireOption(options, "source-sha"),
      runId: requireOption(options, "run-id")
    },
    packageInfo: packageInfo.value,
    report: report.value,
    updateInfo,
    appUpdatePublisherNames
  });
  if (!result.ok) fail(`Signing manifest rejected: ${result.errors.join("; ")}`);
  writeFileSync(outPath, `${JSON.stringify(result.value, null, 2)}\n`);
  printJson(result.value);
}

async function cmdCheckSigningManifest(options: Map<string, string>): Promise<void> {
  const requireProduction = options.get("require-production") === "true";
  const releaseDir = options.get("release-dir");
  if (requireProduction && !releaseDir) fail("--require-production needs --release-dir to re-hash the release set");

  const result = validateSigningManifest(readJsonFile(requireOption(options, "manifest")));
  if (!result.ok) fail(`Invalid signing manifest: ${result.errors.join("; ")}`);
  const manifest = result.value;
  if (requireProduction && !manifest.production) {
    fail(`Signing manifest is not production (mode ${manifest.mode}); refusing to treat it as a publishable release`);
  }
  const provenance = provenanceMismatches(manifest, {
    version: options.get("expected-version"),
    sourceSha: options.get("expected-source-sha"),
    runId: options.get("expected-run-id")
  });
  if (provenance.length > 0) fail(`Signing manifest belongs to another release: ${provenance.join("; ")}`);
  if (releaseDir) {
    const errors = await verifyReleaseSet(resolve(releaseDir), manifest);
    if (errors.length > 0) fail(`Release set does not match signing.json: ${errors.join("; ")}`);
  }
  printJson({
    ok: true,
    mode: manifest.mode,
    production: manifest.production,
    publisher: manifest.publisher,
    version: manifest.version,
    sourceSha: manifest.sourceSha,
    runId: manifest.runId,
    files: manifest.files.length,
    releaseSetVerified: releaseDir !== undefined
  });
}

function readFaultOption(options: Map<string, string>): unknown {
  const inline = options.get("faults");
  const file = options.get("faults-file");
  if (inline && file) fail("pass either --faults or --faults-file, not both");
  if (file) return readJsonFile(file);
  return inline ? (JSON.parse(inline) as unknown) : [];
}

async function cmdFeedServe(options: Map<string, string>): Promise<void> {
  const root = resolve(requireOption(options, "root"));
  if (!existsSync(root)) fail(`--root ${root} does not exist`);
  const portOption = options.get("port") ?? "0";
  const port = Number(portOption);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be an integer between 0 and 65535, got "${portOption}"`);
  const faults = parseFaults(readFaultOption(options));
  const logPath = options.get("log");
  const server = await startFeedServer({
    root,
    port,
    faults,
    onRequest: (entry) => {
      const line = `${JSON.stringify(entry)}\n`;
      if (logPath) appendFileSync(resolve(logPath), line);
      else process.stdout.write(line);
    }
  });
  process.stdout.write(`${JSON.stringify({ listening: server.url, root, faults: faults.length })}\n`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function cmdValidateFeed(options: Map<string, string>): Promise<void> {
  const dir = resolve(requireOption(options, "dir"));
  const channels = options.get("channels");
  const report = await validateReleaseFeed(dir, {
    version: options.get("version"),
    channelFiles: channels ? channels.split(",").map((name) => name.trim()).filter(Boolean) : undefined,
    requireBlockMap: options.get("require-blockmap") === "true"
  });
  printJson(report);
  if (report.errors.length > 0) process.exitCode = 1;
}

function readPlan(options: Map<string, string>): ReleasePlan {
  const shape = validatePlanShape(readJsonFile(requireOption(options, "plan")));
  if (!shape.ok) fail(`Invalid plan: ${shape.errors.join("; ")}`);
  return shape.plan;
}

async function cmdStageReleaseSet(options: Map<string, string>): Promise<void> {
  const staged = await stageReleaseSet(resolve(requireOption(options, "from")), resolve(requireOption(options, "to")), readPlan(options));
  printJson({ staged });
}

function assetsSummary(report: ReleaseAssetsReport, title: string): string {
  const rows = report.assets.map((asset) => `| ${asset.name} | ${asset.size} | \`${asset.sha512}\` |`);
  const status = report.ok ? "passed" : `**failed** (${report.errors.length} problem(s))`;
  return [
    `### ${title}: ${status}`,
    `- version / channel / tag: ${report.version} / ${report.channel} / ${report.tag}`,
    `- source-sha: ${report.sourceSha}`,
    `- signing: mode ${report.signingMode}, production ${report.production}, publisher ${report.publisher ?? "none"}`,
    `- installer signature: ${report.installerSignature ? `${report.installerSignature.status} by ${report.installerSignature.subject ?? "nobody"}, timestamped ${report.installerSignature.timestamped}` : "unknown"}`,
    "",
    "| Asset | Bytes | sha512 |",
    "| --- | --- | --- |",
    ...rows,
    ...report.errors.map((error) => `- ${error}`)
  ].join("\n");
}

async function validateAssetsFromOptions(options: Map<string, string>, dir: string): Promise<ReleaseAssetsReport> {
  const unpackedRoot = options.get("unpacked-root");
  return validateReleaseAssets({
    dir,
    plan: readJsonFile(requireOption(options, "plan")),
    signing: readJsonFile(options.get("signing") ?? resolve(dir, SIGNING_MANIFEST_NAME)),
    runId: requireOption(options, "run-id"),
    requireProduction: options.get("require-production") === "true",
    expectedPublisher: options.get("expected-publisher"),
    unpackedRoot: unpackedRoot ? resolve(unpackedRoot) : undefined
  });
}

async function cmdValidateReleaseAssets(options: Map<string, string>): Promise<void> {
  const report = await validateAssetsFromOptions(options, resolve(requireOption(options, "dir")));
  printJson(report);
  const reportPath = options.get("report");
  if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  appendStepSummary(assetsSummary(report, "Release set validation"));
  if (!report.ok) {
    for (const error of report.errors) annotateError("Release set invalid", error);
    process.exitCode = 1;
  }
}

async function cmdSelectUpgradeBase(options: Map<string, string>, repoRoot: string): Promise<void> {
  const plan = readPlan(options);
  const { owner, repo } = resolveRepo(repoRoot);
  const base = selectUpgradeBase(plan, await createGitHubReleaseClient(owner, repo).listReleases());
  printJson(base);
  writeGithubOutput(
    base.status === "found"
      ? { status: base.status, tag: base.tag, version: base.version, installer: base.installer, reason: "" }
      : { status: base.status, tag: "", version: "", installer: "", reason: base.reason }
  );
}

async function cmdPublish(options: Map<string, string>, repoRoot: string): Promise<void> {
  const dir = resolve(requireOption(options, "dir"));
  const publishOptions = new Map(options);
  publishOptions.set("require-production", "true");
  const report = await validateAssetsFromOptions(publishOptions, dir);
  if (!report.ok) fail(`Release set is not publishable: ${report.errors.join("; ")}`);
  const plan = readPlan(options);
  const { owner, repo } = resolveRepo(repoRoot);
  const workDir = resolve(requireOption(options, "work-dir"));
  mkdirSync(workDir, { recursive: true });
  try {
    const result = await publishRelease({
      plan,
      dir,
      assets: report.assets,
      client: createGitHubReleaseClient(owner, repo),
      source: buildSource(repoRoot),
      workDir,
      log: (line) => process.stderr.write(`${line}\n`),
      onPublic: (release) => writeGithubOutput({ published: "true", url: release.htmlUrl })
    });
    printJson(result);
    writeGithubOutput({ status: result.status });
    appendStepSummary(
      [
        `### Published ${plan.tag} (${result.status})`,
        `- release: ${result.htmlUrl}`,
        `- source-sha: ${plan.sourceSha}`,
        `- prerelease: ${plan.prerelease}, latest: ${plan.makeLatest}`,
        `- resumed draft: ${result.resumed}; uploaded: ${result.uploaded.join(", ") || "none"}; reused: ${result.reused.join(", ") || "none"}; replaced: ${result.replaced.join(", ") || "none"}`
      ].join("\n")
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    annotateError("Publication failed", `${message} (recovery: ${RECOVERY_RUNBOOK})`);
    fail(message);
  }
}

async function cmdCheckPublished(options: Map<string, string>, repoRoot: string): Promise<void> {
  const token = ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => process.env[name]);
  if (token) fail(`${token} is set; the post-publication check must run anonymously, exactly like an installed client`);
  const plan = readPlan(options);
  const { owner, repo } = resolveRepo(repoRoot);
  const attempts = Number(options.get("attempts") ?? "6");
  const delaySeconds = Number(options.get("delay-seconds") ?? "30");
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delaySeconds) || delaySeconds < 0) fail("--attempts must be a positive integer and --delay-seconds a non-negative number");
  const report = await checkPublishedReleaseWithRetries(
    { plan, owner, repo, http: createClientHttp({ fetch }) },
    { attempts, delayMs: delaySeconds * 1000, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) }
  );
  printJson(report);
  const runbook = `https://github.com/${owner}/${repo}/blob/main/${RECOVERY_RUNBOOK}`;
  appendStepSummary(
    [
      `### Client-facing check for ${plan.tag}: ${report.ok ? "passed" : "**failed**"} after ${report.attempts} attempt(s)`,
      "| Check | Result | URL |",
      "| --- | --- | --- |",
      ...report.checks.map((entry) => `| ${entry.name} | ${entry.ok ? "ok" : "FAILED"}: ${entry.detail} | ${entry.url} |`),
      report.ok ? "" : `Recovery: ${runbook}`
    ].join("\n")
  );
  if (!report.ok) {
    for (const entry of report.checks.filter((item) => !item.ok)) annotateError(`Published ${entry.name} check failed`, `${entry.detail} (${entry.url}); recovery: ${runbook}`);
    process.exitCode = 1;
  }
}

function reportLine(level: "error" | "notice", title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS === "true") annotate(level, title, message);
  else process.stdout.write(`${level}: ${title}: ${message}\n`);
}

async function cmdMonitorFeed(options: Map<string, string>, repoRoot: string): Promise<void> {
  const { owner, repo } = resolveRepo(repoRoot);
  const attempts = Number(options.get("attempts") ?? "3");
  const delaySeconds = Number(options.get("delay-seconds") ?? "30");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5 || !Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 300) {
    fail("--attempts must be an integer from 1 to 5 and --delay-seconds a number from 0 to 300");
  }
  const http = createClientHttp({ fetch, apiToken: process.env.GH_TOKEN || undefined });
  const report = await monitorUpdateFeedWithRetries(
    { owner, repo, http, verifyInstallerDigest: options.get("verify-installer-digest") === "true" },
    { attempts, initialDelayMs: delaySeconds * 1000, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) }
  );
  const reportPath = options.get("report");
  if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  const runbook = `https://github.com/${owner}/${repo}/blob/main/${FEED_MONITOR_RUNBOOK}`;
  for (const channel of report.channels) {
    if (channel.notice) reportLine("notice", `No ${channel.channel} feed yet`, channel.notice);
  }
  const failed = [report.listing, ...report.channels.flatMap((channel) => channel.checks.map((entry) => ({ ...entry, name: `${channel.channel} ${entry.name}` })))].filter((entry) => !entry.ok);
  for (const entry of failed) reportLine("error", `Update feed ${entry.name} check failed`, `${entry.detail} (${entry.url}); runbook: ${runbook}`);
  const line = `${report.summary} (attempt ${report.attempts} of ${attempts})`;
  process.stdout.write(`${line}\n`);
  appendStepSummary(report.ok ? line : `${line}\n\nRunbook: ${runbook}`);
  if (!report.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "plan":
      await cmdPlan(options, REPO_ROOT);
      return;
    case "verify-plan":
      await cmdVerifyPlan(options, REPO_ROOT);
      return;
    case "apply":
      await cmdApply(options, REPO_ROOT);
      return;
    case "set-base":
      await cmdSetBase(options, REPO_ROOT);
      return;
    case "check-sync":
      await cmdCheckSync(REPO_ROOT);
      return;
    case "rehash":
      await cmdRehash(options, REPO_ROOT);
      return;
    case "signing-manifest":
      await cmdSigningManifest(options);
      return;
    case "check-signing-manifest":
      await cmdCheckSigningManifest(options);
      return;
    case "feed-serve":
      await cmdFeedServe(options);
      return;
    case "validate-feed":
      await cmdValidateFeed(options);
      return;
    case "stage-release-set":
      await cmdStageReleaseSet(options);
      return;
    case "validate-release-assets":
      await cmdValidateReleaseAssets(options);
      return;
    case "select-upgrade-base":
      await cmdSelectUpgradeBase(options, REPO_ROOT);
      return;
    case "publish":
      await cmdPublish(options, REPO_ROOT);
      return;
    case "check-published":
      await cmdCheckPublished(options, REPO_ROOT);
      return;
    case "monitor-feed":
      await cmdMonitorFeed(options, REPO_ROOT);
      return;
    default:
      fail(
        `Unknown command "${command}". Expected: plan | verify-plan | apply | set-base | check-sync | rehash | signing-manifest | check-signing-manifest | feed-serve | validate-feed | stage-release-set | validate-release-assets | select-upgrade-base | publish | check-published | monitor-feed`
      );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
