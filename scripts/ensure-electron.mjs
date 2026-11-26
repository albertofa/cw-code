// Electron's postinstall can exit 0 without unpacking the binary: under Node 26 its
// extract-zip step never settles and the process just runs out of work, leaving
// dist/ with only locales/ and no path.txt. `bun dev` then fails with
// "Electron uninstall". This runs after `bun install`, checks the binary and, when
// it is missing, reruns Electron's installer under Bun, which unpacks it correctly.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function electronDir() {
  try {
    const require = createRequire(join(root, "apps", "desktop", "package.json"));
    return dirname(require.resolve("electron/package.json"));
  } catch {
    return null;
  }
}

function platformPath() {
  switch (process.env.npm_config_platform || process.platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

function installed(dir) {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (readFileSync(join(dir, "dist", "version"), "utf8").trim().replace(/^v/, "") !== version) return false;
    if (readFileSync(join(dir, "path.txt"), "utf8") !== platformPath()) return false;
  } catch {
    return false;
  }
  return existsSync(process.env.ELECTRON_OVERRIDE_DIST_PATH || join(dir, "dist", platformPath()));
}

const dir = electronDir();
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || dir === null || installed(dir)) process.exit(0);

console.log("[ensure-electron] The Electron binary is missing; running Electron's installer under Bun");
const result = spawnSync(process.execPath, [join(dir, "install.js")], { cwd: dir, stdio: "inherit" });
if (result.status === 0 && installed(dir)) process.exit(0);

console.error(
  `[ensure-electron] The Electron binary is still missing in ${join(dir, "dist")}.\n` +
    `Delete that folder and run: (cd ${dir} && bun install.js)`
);
process.exit(1);
