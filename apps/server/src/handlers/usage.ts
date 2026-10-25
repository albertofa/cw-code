import type { DriverKind, UsageLedgerQuery, UsageReportQuery } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, parseArgs } from "./shared.js";

const DRIVER_KINDS: DriverKind[] = ["claude", "opencode", "codex"];
const MAX_REPORT_DAYS = 366;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDriverList(value: unknown): value is DriverKind[] {
  return Array.isArray(value) && value.length > 0 && value.every((driver) => DRIVER_KINDS.includes(driver as DriverKind));
}

function isValidUsageLedgerQuery(query: unknown): query is UsageLedgerQuery | undefined {
  if (query === undefined) return true;
  if (!query || typeof query !== "object") return false;
  const q = query as Record<string, unknown>;
  if (q.sinceDay !== undefined && (typeof q.sinceDay !== "string" || !DAY_RE.test(q.sinceDay))) return false;
  if (q.sessionId !== undefined && typeof q.sessionId !== "string") return false;
  return true;
}

export function parseUsageReportQuery(args: unknown): UsageReportQuery {
  const query = parseArgs(args, "usage.report");
  const { days, metric, driver, projectId } = query;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_REPORT_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_REPORT_DAYS}`);
  }
  if (metric !== "all" && metric !== "fresh") throw new Error("metric must be 'all' or 'fresh'");
  if (driver !== "all" && !DRIVER_KINDS.includes(driver as DriverKind)) throw new Error("driver must be 'all' or a harness id");
  if (typeof projectId !== "string") throw new Error("projectId must be a string");
  return { days, metric, driver: driver as UsageReportQuery["driver"], projectId };
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
  handle(router, "usage.report", (args) => app.requireServices().usageTopic.report(parseUsageReportQuery(args)));
  handle(router, "usage.refreshAccount", async (args) => {
    const { force, drivers } = parseArgs(args, "usage.refreshAccount");
    if (typeof force !== "boolean") throw new Error("force must be a boolean");
    if (drivers !== undefined && !isDriverList(drivers)) throw new Error("drivers must be a non-empty list of harness ids");
    await app.requireServices().usageTopic.refreshAccount(force, drivers);
  });
}
