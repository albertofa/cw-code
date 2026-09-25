import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.ts";
import { createGitHubReleaseSource } from "../gitHubReleaseSource.ts";
import { applyVersion, checkSync, DEFAULT_PACKAGE_RELATIVE_PATHS, readPackageVersions, setBase } from "../packageVersions.ts";
import { validatePlanShape } from "../planValidation.ts";
import { buildAlphaPlan, buildStablePromotionPlan, verifyPlan } from "../releasePlan.ts";
import type { ReleaseSource } from "../releaseSource.ts";
import { parseGitHubHomepage } from "../repoInfo.ts";
import { type ParsedVersion, FULL_SHA_PATTERN, baseOf, formatVersion, parseVersion, sameBase } from "../semver.ts";

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

function buildSource(repoRoot: string): ReleaseSource {
  const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { homepage?: string };
  if (!rootPackage.homepage) {
    fail(`Root package.json has no "homepage" field to resolve the GitHub repository from`);
  }
  const { owner, repo } = parseGitHubHomepage(rootPackage.homepage);
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
  writeGithubOutput({ stale: result.ok ? "false" : "true" });
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
    default:
      fail(`Unknown command "${command}". Expected: plan | verify-plan | apply | set-base | check-sync`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
