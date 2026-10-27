import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs, requireOwner } from "./shared.js";

export function registerServerHandlers(router: Router, app: ServerApp): void {
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
