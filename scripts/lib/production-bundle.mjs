import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveAsarLib } from "./windows-install.mjs";

export const AUTOTEST_MARKERS = ["cw-update-autotest", "CW_UPDATE_AUTOTEST"];
const AUTOTEST_CHUNK_NAME = /^updateAutotest-.*\.js$/;
const PRODUCTION_MAIN = "out/main/index.js";

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function markersIn(text) {
  return AUTOTEST_MARKERS.filter((marker) => text.includes(marker));
}

export function scanOutMain(outMainDir) {
  const problems = [];
  if (!existsSync(join(outMainDir, "index.js"))) problems.push(`${outMainDir} has no index.js; run the production build first`);
  const files = listFiles(outMainDir);
  for (const file of files) {
    if (AUTOTEST_CHUNK_NAME.test(basename(file))) problems.push(`${file} is an update autotest chunk`);
    if (!/\.[cm]?js$/.test(file)) continue;
    for (const marker of markersIn(readFileSync(file, "utf8"))) problems.push(`${file} contains ${marker}`);
  }
  return { dir: outMainDir, files: files.length, problems };
}

export async function scanAsar(asarPath, desktopDir) {
  const problems = [];
  if (!existsSync(asarPath)) return { path: asarPath, entries: 0, scannedScripts: 0, main: null, problems: [`${asarPath} does not exist`] };
  const asar = await resolveAsarLib(desktopDir);
  if (!asar) return { path: asarPath, entries: 0, scannedScripts: 0, main: null, problems: ["@electron/asar is not resolvable, so app.asar cannot be checked"] };
  const rawEntries = asar.listPackage(asarPath).map((entry) => entry.replace(/^[\\/]/, ""));
  const entries = rawEntries.map((entry) => entry.replace(/\\/g, "/"));
  const entrySet = new Set(entries);
  let main = null;
  try {
    main = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8")).main ?? null;
  } catch (err) {
    problems.push(`app.asar package.json is unreadable: ${err.message}`);
  }
  if (main !== PRODUCTION_MAIN) problems.push(`app.asar package.json main is ${main}, expected ${PRODUCTION_MAIN}`);
  if (!entrySet.has(PRODUCTION_MAIN)) problems.push(`app.asar has no ${PRODUCTION_MAIN}`);
  const testEntries = entries.filter((entry) => entry === "out-updatetest" || entry.startsWith("out-updatetest/"));
  if (testEntries.length > 0) problems.push(`app.asar contains ${testEntries.length} update-test bundle entries under out-updatetest/`);
  let scannedScripts = 0;
  for (const [index, entry] of entries.entries()) {
    if (AUTOTEST_CHUNK_NAME.test(basename(entry))) problems.push(`app.asar contains the update autotest chunk ${entry}`);
    if (!/^out(-updatetest)?\//.test(entry) || !/\.[cm]?js$/.test(entry)) continue;
    scannedScripts += 1;
    let text;
    try {
      text = asar.extractFile(asarPath, rawEntries[index]).toString("utf8");
    } catch (err) {
      problems.push(`app.asar ${entry} could not be read: ${err.message}`);
      continue;
    }
    for (const marker of markersIn(text)) problems.push(`app.asar ${entry} contains ${marker}`);
  }
  return { path: asarPath, entries: entries.length, scannedScripts, main, problems };
}

export async function assertProductionBundle({ outMainDir, asarPath, desktopDir, env }) {
  const problems = [];
  if (env.CW_UPDATE_TEST_BUILD) problems.push("CW_UPDATE_TEST_BUILD is set; production packaging must never run with it");
  const outMain = outMainDir ? scanOutMain(outMainDir) : null;
  const asar = asarPath ? await scanAsar(asarPath, desktopDir) : null;
  problems.push(...(outMain?.problems ?? []), ...(asar?.problems ?? []));
  return { clean: problems.length === 0, outMain, asar, problems };
}
