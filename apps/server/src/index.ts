import pkg from "../package.json" with { type: "json" };
import { ServerApp } from "./app/ServerApp.js";
import { appendCrashLog } from "./debug/crashLog.js";
import { ensureAppDirs, migrateFromUserData, userdataDir } from "./paths/appPaths.js";
import { loadLoginShellEnvironment } from "./shellEnvironment.js";
import { parseServerArgs } from "./transport/args.js";
import { confirmLiveEndpoint, readLiveEndpoint, removeEndpoint } from "./transport/endpointFile.js";

const EXIT_ALREADY_RUNNING = 3;

function reportFatalStartupError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendCrashLog(`fatal startup error: ${detail}`);
  console.error(`fatal startup error: ${detail}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2));
  const running = readLiveEndpoint(userdataDir());
  if (running) {
    if (await confirmLiveEndpoint(running)) {
      process.stdout.write(`CW_SERVER_RUNNING ${JSON.stringify(running)}\n`, () => process.exit(EXIT_ALREADY_RUNNING));
      return;
    }
    removeEndpoint(userdataDir(), running.pid);
  }
  const loginShellWarnings = await loadLoginShellEnvironment(process.platform).catch((err) => [
    `login shell capture failed: ${(err as Error).message}`
  ]);
  ensureAppDirs();
  for (const dir of args.legacyUserData) migrateFromUserData(dir);
  new ServerApp(args, pkg.version).start(loginShellWarnings);
}

main().catch(reportFatalStartupError);
