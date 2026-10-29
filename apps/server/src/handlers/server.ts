import type { ServerHost } from "@cw-code/contracts";
import { homedir, hostname } from "node:os";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, requireOwner } from "./shared.js";

function hostPlatform(): ServerHost["platform"] {
  return process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";
}

export function registerServerHandlers(router: Router, app: ServerApp): void {
  handle(router, "server.host", (): ServerHost => {
    const host: ServerHost = { platform: hostPlatform(), hostname: hostname(), homeDir: homedir(), webUi: app.uiDir !== null };
    return app.bindHost === null ? host : { ...host, bindHost: app.bindHost };
  });
  handle(router, "server.stop", (_args, ctx) => {
    requireOwner(ctx, "stopping the server");
    app.scheduleStop(0);
    return null;
  });
  handle(router, "server.setParent", (args, ctx) => {
    requireOwner(ctx, "changing the watched parent process");
    const { pid } = parseArgs(args, "server.setParent");
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw new Error("pid must be a positive integer");
    app.setParent(pid);
    return null;
  });
}
