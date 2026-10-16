import { posix } from "node:path";

export interface AppImageRelaunch {
  execPath: string;
  args: string[];
}

export function resolveAppImageRelaunch(
  env: Record<string, string | undefined>,
  execPath: string,
  argv: readonly string[]
): AppImageRelaunch | null {
  const appImage = env["APPIMAGE"];
  const appDir = env["APPDIR"];
  if (!appImage || !appDir) return null;
  const rel = posix.relative(posix.resolve(appDir), posix.resolve(execPath));
  if (rel === "" || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return null;
  return { execPath: appImage, args: argv.slice(1) };
}
