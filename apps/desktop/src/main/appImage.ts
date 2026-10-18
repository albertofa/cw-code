import { type PlatformPath, posix } from "node:path";

export interface AppImageRelaunch {
  execPath: string;
  args: string[];
}

export function isInsideAppDir(appDir: string, execPath: string, flavor: PlatformPath = posix): boolean {
  const rel = flavor.relative(flavor.resolve(appDir), flavor.resolve(execPath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(rel);
}

export function resolveAppImageRelaunch(
  env: Record<string, string | undefined>,
  execPath: string,
  argv: readonly string[]
): AppImageRelaunch | null {
  const appImage = env["APPIMAGE"];
  const appDir = env["APPDIR"];
  if (!appImage || !appDir) return null;
  if (!isInsideAppDir(appDir, execPath)) return null;
  return { execPath: appImage, args: argv.slice(1) };
}
