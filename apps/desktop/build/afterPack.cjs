const fs = require("node:fs/promises");
const path = require("node:path");

const PTY_NATIVE_MODULE = path.join("resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "pty.node");

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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }
  const ptyNativeModule = path.join(context.appOutDir, PTY_NATIVE_MODULE);
  if (!(await exists(ptyNativeModule))) {
    throw new Error(`node-pty native module missing from the Linux package: ${ptyNativeModule}. Run pnpm install on Linux so node-pty compiles build/Release/pty.node.`);
  }
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
