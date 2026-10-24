import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerServerHandlers(router: Router, app: ServerApp): void {
  handle(router, "server.stop", () => {
    app.scheduleStop(0);
    return null;
  });
}
