import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ShellTarget {
  file: string;
  args: string[];
}

export interface ResolveEnv {
  pathDirs: string[];
  pathExts: string[];
  platform: NodeJS.Platform;
}

export function currentEnv(): ResolveEnv {
  return {
    pathDirs: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
    pathExts: process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [],
    platform: process.platform
  };
}

export function resolveBinary(name: string, env: ResolveEnv = currentEnv()): string | null {
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null;
  const hasExt = /\.[a-zA-Z0-9]+$/.test(name);
  for (const dir of env.pathDirs) {
    if (hasExt) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    } else if (env.platform !== "win32") {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    } else {
      for (const ext of env.pathExts) {
        const candidate = join(dir, `${name}${ext.toLowerCase()}`);
        if (existsSync(candidate)) return candidate;
      }
      if (!env.pathExts.some((ext) => ext.toLowerCase() === ".ps1")) {
        const ps1 = join(dir, `${name}.ps1`);
        if (existsSync(ps1)) return ps1;
      }
    }
  }
  return null;
}

function quoteWindows(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function toShellTarget(file: string, args: string[], env: ResolveEnv = currentEnv()): ShellTarget {
  if (env.platform !== "win32") {
    const resolved = resolveBinary(file, env);
    if (!resolved) throw new Error(`Cannot find '${file}' on PATH`);
    return { file: resolved, args };
  }
  const resolved = resolveBinary(file, env);
  if (!resolved) throw new Error(`Cannot find '${file}' on PATH`);
  const ext = resolved.split(".").pop()?.toLowerCase();
  if (ext === "ps1") {
    const inner = [resolved, ...args].map(quoteWindows).join(" ");
    return { file: "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", `& ${inner}`] };
  }
  if (ext === "cmd" || ext === "bat") {
    const inner = [resolved, ...args].map(quoteWindows).join(" ");
    return { file: "cmd.exe", args: ["/k", inner] };
  }
  return { file: resolved, args };
}
