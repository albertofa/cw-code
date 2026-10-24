import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  flag: string | null;
  platform: NodeJS.Platform;
  arch: string;
}

interface NativeLayout {
  dir: string;
  required: string[];
}

const BUN_TARGET_OS: Readonly<Record<string, NodeJS.Platform>> = { windows: "win32", linux: "linux", darwin: "darwin" };

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(serverDir, "dist");

function fail(message: string): never {
  console.error(`[server build] ${message}`);
  process.exit(1);
}

function parseTarget(argv: string[]): Target {
  const index = argv.findIndex((arg) => arg === "--target" || arg.startsWith("--target="));
  if (index === -1) return { flag: null, platform: process.platform, arch: process.arch };
  const flag = argv[index].includes("=") ? argv[index].slice("--target=".length) : argv[index + 1];
  const match = flag ? /^bun-(windows|linux|darwin)-(x64|arm64)(?:-|$)/.exec(flag) : null;
  if (!flag || !match) fail(`unsupported --target ${JSON.stringify(flag)}; expected bun-<windows|linux|darwin>-<x64|arm64>[-...]`);
  return { flag, platform: BUN_TARGET_OS[match[1]], arch: match[2] };
}

function nativeLayout(target: Target): NativeLayout {
  if (target.platform === "win32") {
    const dir = `prebuilds/win32-${target.arch}`;
    return { dir, required: [`${dir}/pty.node`, `${dir}/conpty.node`, `${dir}/conpty/conpty.dll`, `${dir}/conpty/OpenConsole.exe`] };
  }
  if (target.platform === "linux") {
    return { dir: "build/Release/pty.node", required: ["build/Release/pty.node"] };
  }
  fail(`no node-pty packaging layout for ${target.platform}-${target.arch}`);
}

function compileServer(target: Target, outfile: string): void {
  const args = ["build", "src/index.ts", "--compile", "--external", "node-pty", "--outfile", outfile];
  if (target.flag) args.push("--target", target.flag);
  const result = Bun.spawnSync([process.execPath, ...args], { cwd: serverDir, stdio: ["ignore", "inherit", "inherit"] });
  if (result.exitCode !== 0) fail(`bun ${args.join(" ")} exited with code ${result.exitCode}`);
  if (!existsSync(outfile)) fail(`bun build reported success but ${outfile} is missing`);
}

function isRuntimeLibFile(source: string): boolean {
  return !source.endsWith(".test.js") && !source.endsWith(".js.map");
}

function requireNodePtyNatives(target: Target, ptyDir: string): NativeLayout {
  const layout = nativeLayout(target);
  const missing = layout.required.filter((file) => !existsSync(join(ptyDir, file)));
  if (missing.length > 0) {
    const hint = target.platform === "linux" ? " Run bun install on Linux with a C++ toolchain so node-pty compiles build/Release/pty.node." : "";
    fail(`node-pty native files for ${target.platform}-${target.arch} are missing from ${ptyDir}: ${missing.join(", ")}.${hint}`);
  }
  return layout;
}

function copyNodePty(ptyDir: string, layout: NativeLayout): string {
  const outDir = join(distDir, "node_modules", "node-pty");
  mkdirSync(outDir, { recursive: true });
  for (const file of ["package.json", "LICENSE"]) cpSync(join(ptyDir, file), join(outDir, file));
  cpSync(join(ptyDir, "lib"), join(outDir, "lib"), { recursive: true, filter: isRuntimeLibFile });
  cpSync(join(ptyDir, layout.dir), join(outDir, layout.dir), { recursive: true, filter: (source) => !source.endsWith(".pdb") });
  return outDir;
}

const target = parseTarget(process.argv.slice(2));
const ptyDir = dirname(createRequire(join(serverDir, "package.json")).resolve("node-pty/package.json"));
const layout = requireNodePtyNatives(target, ptyDir);
const outfile = join(distDir, target.platform === "win32" ? "cw-code-server.exe" : "cw-code-server");
rmSync(distDir, { recursive: true, force: true });
compileServer(target, outfile);
const ptyOut = copyNodePty(ptyDir, layout);
console.log(`[server build] ${outfile}`);
console.log(`[server build] ${ptyOut}`);
