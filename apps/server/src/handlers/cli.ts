import type { CliBinary } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { discoverBinaries, verifyBinaryPath } from "../cli/binaryDiscovery.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerCliHandlers(router: Router, app: ServerApp): void {
  handle(router, "cli.checkVersions", async () => {
    return (await app.requireServices().harnessMonitor.check("recheck")).checks;
  });
  handle(router, "cli.recheck", async () => {
    return app.requireServices().harnessMonitor.check("recheck");
  });
  handle<{ binaries?: CliBinary[] } | undefined>(router, "cli.discover", (args) => discoverBinaries(args?.binaries));
  handle<{ binary: CliBinary; path: string } | undefined>(router, "cli.verifyPath", (args) => {
    if (!args || typeof args.binary !== "string" || typeof args.path !== "string") {
      throw new Error("cli.verifyPath requires { binary, path }");
    }
    return verifyBinaryPath(args.binary, args.path);
  });
}
