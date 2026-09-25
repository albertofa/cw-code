import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { validateReleaseFeed } from "../../tools/release/src/feedManifest.ts";
import { readReleaseUpdateInfo } from "../../tools/release/src/rehash.ts";
import { parseScalar } from "../../tools/release/src/updateInfoYaml.ts";
import { UPDATE_TEST_EXECUTABLE } from "../../tools/release/src/upgradeScenarios.ts";
import { resolveAsarLib } from "./windows-install.mjs";

const AUTOTEST_CHUNK = /(^|[\\/])out-updatetest[\\/]main[\\/]updateAutotest-[^\\/]+\.js$/;
const SIGNING_ENV = ["CSC_LINK", "WIN_CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_KEY_PASSWORD", "CSC_NAME"];

function desktopBin(desktopDir, packageName, binName) {
  const desktopRequire = createRequire(join(desktopDir, "package.json"));
  const packageJsonPath = desktopRequire.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const relativeBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin[binName];
  return join(dirname(packageJsonPath), relativeBin);
}

function buildEnv(testBuild) {
  const env = { ...process.env };
  for (const name of SIGNING_ENV) delete env[name];
  if (testBuild) env.CW_UPDATE_TEST_BUILD = "1";
  else delete env.CW_UPDATE_TEST_BUILD;
  return env;
}

function runNodeScript(script, args, cwd, env) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${basename(script)} ${args.join(" ")} failed with exit ${result.status}`);
}

export function buildMainBundle(desktopDir, testBuild) {
  runNodeScript(desktopBin(desktopDir, "electron-vite", "electron-vite"), ["build"], desktopDir, buildEnv(testBuild));
}

export function packageUpdateTestBuild(desktopDir, version, outputDir, feedUrl) {
  const args = [
    "--config",
    "electron-builder.updatetest.yml",
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
    `-c.directories.output=${outputDir}`
  ];
  if (feedUrl) args.push(`-c.publish.url=${feedUrl}`);
  runNodeScript(desktopBin(desktopDir, "electron-builder", "electron-builder"), args, desktopDir, buildEnv(false));
}

export function parseAppUpdateYaml(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s+(.+)$/.exec(line);
    if (match) result[match[1]] = parseScalar(match[2]);
  }
  return result;
}

export function appUpdateProblems(appUpdate) {
  if (!appUpdate) return ["resources/app-update.yml is missing"];
  const problems = [];
  if (appUpdate.provider !== "generic") problems.push(`app-update.yml provider is ${appUpdate.provider}, expected generic`);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(appUpdate.url ?? "")) problems.push(`app-update.yml url ${appUpdate.url} is not a loopback feed`);
  if (!String(appUpdate.updaterCacheDirName ?? "").includes("updatetest")) {
    problems.push(`updaterCacheDirName ${appUpdate.updaterCacheDirName} is not the update-test identity`);
  }
  return problems;
}

export async function describeUpdateTestBuild(desktopDir, dir, version) {
  const report = await validateReleaseFeed(dir, { version, requireBlockMap: true });
  const errors = [...report.errors];
  const appUpdatePath = join(dir, "win-unpacked", "resources", "app-update.yml");
  const appUpdate = existsSync(appUpdatePath) ? parseAppUpdateYaml(readFileSync(appUpdatePath, "utf8")) : null;
  errors.push(...appUpdateProblems(appUpdate));
  const unpackedExe = join(dir, "win-unpacked", UPDATE_TEST_EXECUTABLE);
  if (!existsSync(unpackedExe)) errors.push(`${UPDATE_TEST_EXECUTABLE} is missing from win-unpacked`);

  let autotestChunk = null;
  const asarPath = join(dir, "win-unpacked", "resources", "app.asar");
  if (existsSync(asarPath)) {
    const asar = await resolveAsarLib(desktopDir);
    if (!asar) errors.push("@electron/asar is not resolvable, so app.asar cannot be checked for the autotest chunk");
    else {
      autotestChunk = asar.listPackage(asarPath).find((entry) => AUTOTEST_CHUNK.test(entry)) ?? null;
      if (!autotestChunk) errors.push("app.asar has no out-updatetest/main/updateAutotest chunk; this is not an update-test build");
    }
  } else {
    errors.push("app.asar is missing from win-unpacked");
  }

  let info = null;
  if (report.errors.length === 0) info = await readReleaseUpdateInfo(dir);
  return {
    version,
    dir,
    installerName: info?.installerName ?? null,
    installerPath: info ? join(dir, info.installerName) : null,
    sha512: info?.sha512 ?? null,
    size: info ? statSync(join(dir, info.installerName)).size : null,
    channelFiles: info?.files ?? [],
    blockMap: report.blockMap,
    appUpdate,
    unpackedExe,
    autotestChunk,
    errors
  };
}
