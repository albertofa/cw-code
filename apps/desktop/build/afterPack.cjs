const fs = require("node:fs/promises");
const path = require("node:path");

const sandboxWrapper = (binaryName) => `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
if [ "$(stat -c '%u:%a' "$here/chrome-sandbox" 2>/dev/null)" != "0:4755" ] &&
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
  exec "$here/${binaryName}" --no-sandbox "$@"
fi
exec "$here/${binaryName}" "$@"
`;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }
  const executableName = context.packager.executableName;
  const binaryName = `${executableName}-bin`;
  const executablePath = path.join(context.appOutDir, executableName);
  await fs.rename(executablePath, path.join(context.appOutDir, binaryName));
  await fs.writeFile(executablePath, sandboxWrapper(binaryName), { mode: 0o755 });
  await fs.chmod(executablePath, 0o755);
};
