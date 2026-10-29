import type { ShutdownPrepareRequest, ShutdownReason } from "@cw-code/contracts";
import type { ServerApp } from "../app/ServerApp.js";
import type { Router } from "../transport/Router.js";
import { handle, requireOwner } from "./shared.js";

const SHUTDOWN_REASONS: ShutdownReason[] = ["quit", "update"];
const SHUTDOWN_TIMEOUT_MAX_MS = 120_000;

function parseShutdownPrepare(args: unknown): ShutdownPrepareRequest {
  const request = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const reason = request.reason;
  const timeoutMs = request.timeoutMs;
  if (typeof reason !== "string" || !SHUTDOWN_REASONS.includes(reason as ShutdownReason)) {
    throw new Error("shutdown.prepare requires reason 'quit' or 'update'");
  }
  if (typeof request.stopActiveTurns !== "boolean") throw new Error("shutdown.prepare requires a boolean stopActiveTurns");
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SHUTDOWN_TIMEOUT_MAX_MS) {
    throw new Error(`shutdown.prepare requires timeoutMs between 1 and ${SHUTDOWN_TIMEOUT_MAX_MS}`);
  }
  const approved = request.approvedTurnIds;
  if (approved !== undefined && (!Array.isArray(approved) || !approved.every((id) => typeof id === "string"))) {
    throw new Error("shutdown.prepare approvedTurnIds must be an array of turn ids");
  }
  return {
    reason: reason as ShutdownReason,
    stopActiveTurns: request.stopActiveTurns,
    timeoutMs,
    ...(approved !== undefined ? { approvedTurnIds: approved as string[] } : {})
  };
}

function parseShutdownToken(args: unknown, channel: string): string {
  const token = args && typeof args === "object" ? (args as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0) throw new Error(`${channel} requires { token }`);
  return token;
}

export function registerShutdownHandlers(router: Router, app: ServerApp): void {
  const shutdown = () => app.requireServices().shutdown;
  const reporting = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } finally {
      app.emitShutdownChanged();
    }
  };
  handle(router, "shutdown.assess", () => shutdown().assess());
  handle(router, "shutdown.status", () => app.shutdownStatus());
  handle(router, "shutdown.prepare", (args, ctx) => {
    requireOwner(ctx, "preparing a shutdown");
    const request = parseShutdownPrepare(args);
    return reporting(() => shutdown().prepare(request));
  });
  handle(router, "shutdown.force", (args, ctx) => {
    requireOwner(ctx, "forcing a shutdown");
    const token = parseShutdownToken(args, "shutdown.force");
    return reporting(() => shutdown().force(token));
  });
  handle(router, "shutdown.cancel", (args) => {
    const token = parseShutdownToken(args, "shutdown.cancel");
    return reporting(() => {
      shutdown().cancel(token);
    });
  });
  handle(router, "shutdown.quit", (args, ctx) => {
    requireOwner(ctx, "quitting the server");
    return app.quit(parseShutdownToken(args, "shutdown.quit"));
  });
}
