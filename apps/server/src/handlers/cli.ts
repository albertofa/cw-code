import type { CliBinary, DriverKind } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import { discoverBinaries, verifyBinaryPath } from "../cli/binaryDiscovery.js";
import { DRIVER_KINDS } from "../prefs/PreferencesStore.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

function isDriverKindList(value: unknown): value is DriverKind[] {
  return Array.isArray(value) && value.every((binary) => DRIVER_KINDS.includes(binary as DriverKind));
}

export function registerCliHandlers(router: Router, app: ServerApp): void {
  handle(router, "cli.recheck", async () => {
    const { harnessMonitor, harnessUpdates } = app.requireServices();
    const availability = await harnessMonitor.check("recheck");
    void harnessUpdates.refresh({ fresh: true });
    return availability;
  });
  handle(router, "cli.checkUpdates", () => app.requireServices().harnessUpdates.refresh({ fresh: true }));
  handle<{ binaries?: unknown } | undefined>(router, "cli.update", (args) => {
    if (!isDriverKindList(args?.binaries)) throw new Error("cli.update requires { binaries }");
    return app.requireServices().harnessUpdates.update(args.binaries);
  });
  handle<{ binaries?: CliBinary[] } | undefined>(router, "cli.discover", (args) => discoverBinaries(args?.binaries));
  handle<{ binary: CliBinary; path: string } | undefined>(router, "cli.verifyPath", (args) => {
    if (!args || typeof args.binary !== "string" || typeof args.path !== "string") {
      throw new Error("cli.verifyPath requires { binary, path }");
    }
    return verifyBinaryPath(args.binary, args.path);
  });
}
