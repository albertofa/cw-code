const fs = require("node:fs/promises");
const path = require("node:path");

const SERVER_DIR = path.join("resources", "server");
const UI_INDEX = path.join(SERVER_DIR, "ui", "index.html");
const SERVER_FILES = {
  win32: [path.join(SERVER_DIR, "cw-code-server.exe"), path.join(SERVER_DIR, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"), UI_INDEX],
  linux: [path.join(SERVER_DIR, "cw-code-server"), path.join(SERVER_DIR, "node_modules", "node-pty", "build", "Release", "pty.node"), UI_INDEX]
};

const sandboxWrapper = (executableName, binaryName) => `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
label=$(cat "/proc/$$/attr/apparmor/current" 2>/dev/null || cat "/proc/$$/attr/current" 2>/dev/null)
case "$label" in
  "${executableName} "*) ;;
  *)
    if [ "$(stat -c '%u:%a' "$here/chrome-sandbox" 2>/dev/null)" != "0:4755" ] &&
      [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
      exec "$here/${binaryName}" --no-sandbox "$@"
    fi
    ;;
esac
exec "$here/${binaryName}" "$@"
`;

const exists = (target) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

async function requireServerFiles(context) {
  const required = SERVER_FILES[context.electronPlatformName] ?? [];
  for (const file of required) {
    const target = path.join(context.appOutDir, file);
    if (!(await exists(target))) {
      throw new Error(`cw-code server file missing from the package: ${target}. Run bun --filter @cw-code/ui build and bun --filter @cw-code/server compile before electron-builder.`);
    }
  }
}

exports.default = async function afterPack(context) {
  await requireServerFiles(context);
  if (context.electronPlatformName !== "linux") {
    return;
  }
  await fs.chmod(path.join(context.appOutDir, SERVER_FILES.linux[0]), 0o755);
  const executableName = context.packager.executableName;
  const binaryName = `${executableName}-bin`;
  const executablePath = path.join(context.appOutDir, executableName);
  const binaryPath = path.join(context.appOutDir, binaryName);
  if (!(await exists(binaryPath))) {
    await fs.rename(executablePath, binaryPath);
  }
  await fs.writeFile(executablePath, sandboxWrapper(executableName, binaryName), { mode: 0o755 });
  await fs.chmod(executablePath, 0o755);
};
