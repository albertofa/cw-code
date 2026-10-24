import { posix, win32 } from "node:path";

export interface BunLookup {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  exists(path: string): boolean;
}

export function resolveBunBinary({ env, platform, homeDir, exists }: BunLookup): string {
  const exe = platform === "win32" ? "bun.exe" : "bun";
  const path = platform === "win32" ? win32 : posix;
  const explicit = env.CW_BUN?.trim();
  if (explicit) return explicit;
  const execPath = env.npm_execpath?.trim();
  if (execPath && path.basename(execPath).toLowerCase().startsWith("bun")) return execPath;
  const installDir = env.BUN_INSTALL?.trim();
  const candidates = [...(installDir ? [path.join(installDir, "bin", exe)] : []), path.join(homeDir, ".bun", "bin", exe)];
  return candidates.find((candidate) => exists(candidate)) ?? exe;
}
