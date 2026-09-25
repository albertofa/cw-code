import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANUAL_SCENARIOS,
  UPGRADE_SCENARIOS,
  deriveUpdateTestVersions,
  redactText,
  redactValue,
  requiredBuilds,
  selectScenarios
} from "../tools/release/src/upgradeScenarios.ts";
import { buildMainBundle, bundleMarkerHits, describeUpdateTestBuild, packageUpdateTestBuild } from "./lib/upgrade-builds.mjs";
import { dryRunFeed, runScenario, runUnpackedAutotestSmoke, stageFeed, updateTestIdentity } from "./lib/upgrade-run.mjs";
import { runProductionBytes } from "./lib/production-bytes.mjs";
import { isElevated, requireDisposableEnvironment } from "./lib/windows-install.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps", "desktop");
const DEFAULT_FEED_PORT = 47613;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    build: true,
    buildsDir: join(desktopDir, "dist-updatetest"),
    workDir: join(tmpdir(), `cw-upgrade-test-${Date.now()}`),
    evidence: null,
    scenarios: null,
    feedPort: DEFAULT_FEED_PORT,
    disposableEnvironment: false,
    appSmoke: true,
    assertProductionBundle: null,
    productionBytes: false,
    installer: null,
    candidateDir: null,
    devToolsPort: 9339
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skip-build") args.build = false;
    else if (arg === "--builds-dir") args.buildsDir = resolve(value());
    else if (arg === "--work-dir") args.workDir = resolve(value());
    else if (arg === "--evidence") args.evidence = resolve(value());
    else if (arg === "--scenarios") args.scenarios = value().split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--feed-port") args.feedPort = Number(value());
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else if (arg === "--skip-app-smoke") args.appSmoke = false;
    else if (arg === "--assert-production-bundle") args.assertProductionBundle = argv[i + 1] && !argv[i + 1].startsWith("--") ? resolve(value()) : join(desktopDir, "out", "main");
    else if (arg === "--production-bytes") args.productionBytes = true;
    else if (arg === "--installer") args.installer = resolve(value());
    else if (arg === "--candidate-dir") args.candidateDir = resolve(value());
    else if (arg === "--devtools-port") args.devToolsPort = Number(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.feedPort) || args.feedPort < 1 || args.feedPort > 65535) throw new Error("--feed-port must be a TCP port");
  return args;
}

function redactions(args) {
  const env = process.env;
  return [
    [args.workDir, "<work>"],
    [repoRoot, "<repo>"],
    [env.LOCALAPPDATA ?? "", "%LOCALAPPDATA%"],
    [env.APPDATA ?? "", "%APPDATA%"],
    [env.USERPROFILE ?? "", "%USERPROFILE%"],
    [tmpdir(), "<temp>"],
    [process.execPath, "<node>"]
  ];
}

function writeEvidence(path, evidence, args) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactValue(evidence, redactions(args)), null, 2)}\n`, "utf8");
}

function copyRedactedLogs(records, args, logsDir) {
  for (const record of records) {
    const target = join(logsDir, record.id);
    mkdirSync(target, { recursive: true });
    const sources = [
      record.logs.outPath,
      record.logs.recoveryOutPath,
      record.logs.wizardLog,
      record.logs.fakeLog,
      join(record.logs.cwCodeHome, "logs", "updater.log"),
      join(record.logs.cwCodeHome, "logs", "crash.log")
    ];
    for (const source of sources) {
      if (!existsSync(source)) continue;
      writeFileSync(join(target, source.split(/[\\/]/).pop()), redactText(readFileSync(source, "utf8"), redactions(args)), "utf8");
    }
    delete record.logs;
  }
}

function assertProductionBundle(outMainDir) {
  if (!existsSync(outMainDir)) throw new Error(`${outMainDir} does not exist; run the production build first`);
  const hits = bundleMarkerHits(outMainDir);
  return { dir: outMainDir, clean: hits.length === 0, hits: hits.map((hit) => ({ file: hit.file, marker: hit.marker })) };
}

async function prepareBuilds(args, versions, keys) {
  const builds = {};
  if (args.build && keys.length > 0) {
    buildMainBundle(desktopDir, true);
    try {
      const feedUrl = args.feedPort === DEFAULT_FEED_PORT ? null : `http://127.0.0.1:${args.feedPort}/`;
      for (const key of keys) packageUpdateTestBuild(desktopDir, versions[key], join(args.buildsDir, versions[key]), feedUrl);
    } finally {
      buildMainBundle(desktopDir, false);
    }
  }
  const problems = [];
  for (const key of keys) {
    const build = await describeUpdateTestBuild(desktopDir, join(args.buildsDir, versions[key]), versions[key]);
    builds[key] = build;
    problems.push(...build.errors.map((error) => `${key} (${versions[key]}): ${error}`));
  }
  return { builds, problems };
}

function summarizeBuild(key, build) {
  return {
    key,
    version: build.version,
    installer: build.installerName,
    sizeBytes: build.size,
    sha512: build.sha512,
    channelFiles: build.channelFiles,
    blockMap: build.blockMap,
    feedUrl: build.appUpdate?.url ?? null,
    updaterCacheDirName: build.appUpdate?.updaterCacheDirName ?? null,
    autotestChunk: build.autotestChunk
  };
}

function measurements(records) {
  return records
    .filter((record) => record.observed?.advertisedInstaller)
    .map((record) => {
      const bytes = record.observed.transfers.filter((entry) => entry.path === record.observed.advertisedInstaller).reduce((total, entry) => total + entry.bytes, 0);
      return {
        scenario: record.id,
        transfer: record.observed.transfer,
        installerBytes: record.observed.advertisedInstallerSize,
        bytesServed: bytes,
        ratio: record.observed.advertisedInstallerSize ? Number((bytes / record.observed.advertisedInstallerSize).toFixed(4)) : null,
        downloadMs: record.timings.downloadMs ?? null,
        installToRelaunchMs: record.timings.installToRelaunchMs ?? null
      };
    });
}

async function runUpdateTests(args) {
  const versions = deriveUpdateTestVersions(JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8")).version);
  const elevated = process.platform === "win32" && isElevated();
  const { selected, skipped } = selectScenarios(args.scenarios, { elevated });
  const keys = requiredBuilds(selected);
  if (!args.dryRun) requireDisposableEnvironment("verify-installed-upgrade", args.disposableEnvironment);
  mkdirSync(args.workDir, { recursive: true });

  const { builds, problems } = await prepareBuilds(args, versions, keys);
  const productionBundle = assertProductionBundle(join(desktopDir, "out", "main"));
  if (!productionBundle.clean) problems.push(`the production main bundle still contains autotest markers: ${productionBundle.hits.map((hit) => hit.marker).join(", ")}`);

  const evidence = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    mode: args.dryRun ? "dry-run" : "installed",
    host: { platform: process.platform, release: release(), node: process.version, elevated, ci: process.env.CI === "true" },
    versions,
    builds: keys.map((key) => summarizeBuild(key, builds[key])),
    productionBundle,
    selected: selected.map((entry) => entry.id),
    skipped,
    manual: MANUAL_SCENARIOS,
    problems
  };

  if (problems.length === 0 && args.dryRun) {
    evidence.plans = [];
    for (const entry of selected) {
      const staged = stageFeed(entry, builds, versions, join(args.workDir, entry.id, "feed"));
      evidence.plans.push({
        id: entry.id,
        group: entry.group,
        install: versions[entry.install],
        scope: entry.scope,
        mode: entry.mode,
        busyTurn: entry.busyTurn,
        sabotage: entry.sabotage,
        advertised: staged.advertised,
        expect: entry.expect,
        feed: await dryRunFeed(entry, staged)
      });
    }
    if (args.appSmoke && builds.n) evidence.unpackedAutotestSmoke = await runUnpackedAutotestSmoke(builds.n.unpackedExe, args.workDir);
    for (const plan of evidence.plans) {
      if (plan.feed.validation?.errors.length) problems.push(`${plan.id}: staged feed is invalid: ${plan.feed.validation.errors.join("; ")}`);
    }
    problems.push(...(evidence.unpackedAutotestSmoke?.problems ?? []));
  }

  if (problems.length === 0 && !args.dryRun) {
    const identity = updateTestIdentity(builds[keys[0]]?.appUpdate?.updaterCacheDirName);
    const records = [];
    for (const entry of selected) {
      console.log(`== ${entry.id}: ${entry.title}`);
      const record = await runScenario(entry, { builds, versions, workDir: args.workDir, identity });
      console.log(record.problems.length === 0 ? "   passed" : `   FAILED\n${record.problems.map((problem) => `   - ${problem}`).join("\n")}`);
      records.push(record);
    }
    copyRedactedLogs(records, args, join(dirname(args.evidence ?? join(args.workDir, "evidence.json")), "logs"));
    evidence.scenarios = records;
    evidence.measurements = measurements(records);
    for (const record of records) problems.push(...record.problems.map((problem) => `${record.id}: ${problem}`));
  }

  evidence.passed = problems.length === 0;
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.assertProductionBundle) {
    const result = assertProductionBundle(args.assertProductionBundle);
    console.log(JSON.stringify(result, null, 2));
    if (!result.clean) process.exitCode = 1;
    return;
  }
  const evidencePath = args.evidence ?? join(args.workDir, "evidence.json");
  if (args.productionBytes) {
    if (!args.installer || !args.candidateDir) throw new Error("--production-bytes needs --installer <N installer> and --candidate-dir <N+1 release set>");
    mkdirSync(args.workDir, { recursive: true });
    const report = await runProductionBytes({
      installer: args.installer,
      candidateDir: args.candidateDir,
      feedPort: args.feedPort,
      devToolsPort: args.devToolsPort,
      disposableEnvironment: args.disposableEnvironment,
      workDir: args.workDir,
      wizardDriver: join(__dirname, "lib", "drive-installer-wizard.ps1")
    });
    report.passed = report.problems.length === 0;
    writeEvidence(evidencePath, report, args);
    const wizardLog = join(args.workDir, "production-wizard.jsonl");
    if (existsSync(wizardLog)) copyFileSync(wizardLog, join(dirname(evidencePath), "production-wizard.jsonl"));
    console.log(`production-bytes evidence: ${evidencePath}`);
    if (!report.passed) {
      console.error(report.problems.map((problem) => `  - ${problem}`).join("\n"));
      process.exitCode = 1;
    }
    return;
  }
  const evidence = await runUpdateTests(args);
  writeEvidence(evidencePath, evidence, args);
  console.log(`evidence: ${evidencePath}`);
  console.log(`scenarios: ${evidence.selected.length} selected of ${UPGRADE_SCENARIOS.length}, ${evidence.skipped.length} skipped, ${MANUAL_SCENARIOS.length} manual`);
  if (!evidence.passed) {
    console.error("FAILED:");
    for (const problem of evidence.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
