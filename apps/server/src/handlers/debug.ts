import { appendFileSync } from "node:fs";
import { getHarnessTracePath } from "../debug/harnessTrace.js";
import { runServerPackageProbe } from "../debug/packageProbe.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

export function registerDebugHandlers(router: Router): void {
  handle(router, "debug.tracePath", (): { ok: boolean; path?: string; error?: string } => {
    const tracePath = getHarnessTracePath();
    if (!tracePath) return { ok: false, error: "harness trace is not initialized" };
    try {
      appendFileSync(tracePath, "", "utf8");
    } catch (err) {
      return { ok: false, path: tracePath, error: (err as Error).message };
    }
    return { ok: true, path: tracePath };
  });
  handle(router, "debug.packageProbe", () => runServerPackageProbe());
}
