import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactValue } from "../tools/release/src/upgradeScenarios.ts";
import { LINUX_SCENARIOS, runLinuxProductionBytes } from "./lib/linux-production-bytes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    productionBytes: false,
    appImage: null,
    deb: null,
    candidateDir: null,
    workDir: join(tmpdir(), `cw-linux-upgrade-${Date.now()}`),
    evidence: null,
    desktopDir: join(repoRoot, "apps", "desktop"),
    feedPort: 47613,
    devToolsPort: 9339,
    scenarios: LINUX_SCENARIOS,
    disposableEnvironment: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--production-bytes") args.productionBytes = true;
    else if (arg === "--appimage") args.appImage = resolve(value());
    else if (arg === "--deb") args.deb = resolve(value());
    else if (arg === "--candidate-dir") args.candidateDir = resolve(value());
    else if (arg === "--work-dir") args.workDir = resolve(value());
    else if (arg === "--evidence") args.evidence = resolve(value());
    else if (arg === "--desktop-dir") args.desktopDir = resolve(value());
    else if (arg === "--feed-port") args.feedPort = Number(value());
    else if (arg === "--devtools-port") args.devToolsPort = Number(value());
    else if (arg === "--scenarios") args.scenarios = value().split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--disposable-environment") args.disposableEnvironment = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.productionBytes) throw new Error("verify-linux-upgrade only has the --production-bytes mode");
  if (!args.candidateDir) throw new Error("--production-bytes needs --candidate-dir <N+1 release set>");
  for (const port of [args.feedPort, args.devToolsPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--feed-port and --devtools-port must be TCP ports");
  }
  const unknown = args.scenarios.filter((name) => !LINUX_SCENARIOS.includes(name));
  if (unknown.length > 0 || args.scenarios.length === 0) throw new Error(`--scenarios takes ${LINUX_SCENARIOS.join(",")}`);
  return args;
}

function writeEvidence(path, report, args) {
  const replacements = [
    [args.workDir, "<work>"],
    [repoRoot, "<repo>"],
    [tmpdir(), "<temp>"],
    [homedir(), "~"],
    [process.execPath, "<node>"]
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactValue(report, replacements), null, 2)}\n`, "utf8");
}

function describe(record) {
  const relaunched = record.relaunched ? `${record.relaunched.runningVersion}${record.relaunched.reported ? ` (reports ${record.relaunched.reported.runningVersion})` : ""}` : "none";
  const feed = record.feed ? `${record.feed.bytesServed}/${record.feed.packageBytes} bytes${record.feed.differential ? ", differential" : ""}` : "n/a";
  return `${record.id}: N ${record.before?.runningVersion ?? "?"} -> relaunched ${relaunched}; probe ${record.probe?.appVersion ?? "not run"}; feed ${feed}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidencePath = args.evidence ?? join(args.workDir, "linux-production-bytes.json");
  mkdirSync(args.workDir, { recursive: true });
  const report = await runLinuxProductionBytes({ ...args, onUpdate: (partial) => writeEvidence(evidencePath, partial, args) });
  writeEvidence(evidencePath, report, args);
  console.log(`linux production-bytes evidence: ${evidencePath}`);
  for (const record of report.scenarios) console.log(`  ${describe(record)}`);
  if (!report.passed) {
    console.error(report.problems.map((problem) => `  - ${problem}`).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
