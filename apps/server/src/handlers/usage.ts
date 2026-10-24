import type { DriverKind, UsageLedgerQuery } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle } from "./shared.js";

const DRIVER_KINDS: DriverKind[] = ["claude", "opencode", "codex"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidUsageLedgerQuery(query: unknown): query is UsageLedgerQuery | undefined {
  if (query === undefined) return true;
  if (!query || typeof query !== "object") return false;
  const q = query as Record<string, unknown>;
  if (q.sinceDay !== undefined && (typeof q.sinceDay !== "string" || !DAY_RE.test(q.sinceDay))) return false;
  if (q.sessionId !== undefined && typeof q.sessionId !== "string") return false;
  return true;
}

export function registerUsageHandlers(router: Router, app: ServerApp): void {
  handle(router, "usage.ledger", (query) => {
    if (!isValidUsageLedgerQuery(query)) {
      throw new Error("usage.ledger requires { sinceDay?: string (YYYY-MM-DD), sessionId?: string }");
    }
    return app.requireServices().sessions.queryUsageLedger(query ?? {});
  });
  handle<{ drivers: DriverKind[]; force?: boolean } | undefined>(router, "usage.account", (args) => {
    if (!args || !Array.isArray(args.drivers) || !args.drivers.every((driver) => DRIVER_KINDS.includes(driver))) {
      throw new Error("usage.account requires { drivers: DriverKind[] }");
    }
    return app.requireServices().accountUsage.get(args.drivers, args.force ?? false);
  });
}
