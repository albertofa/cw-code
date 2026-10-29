import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerApp } from "../app/ServerApp.js";
import { Router, type CallContext } from "../transport/Router.js";
import { registerShutdownHandlers } from "./shutdown.js";

const OWNER: CallContext = { clientId: "a", client: "desktop-shell", auth: { kind: "owner" } };
const DEVICE: CallContext = { clientId: "b", client: "web", auth: { kind: "device", deviceId: "dev_1" } };
const PREPARE = { reason: "quit", stopActiveTurns: false, timeoutMs: 1_000 };

let calls: string[];
let router: Router;

beforeEach(() => {
  calls = [];
  const shutdown = {
    prepare: () => calls.push("prepare"),
    force: () => calls.push("force"),
    cancel: () => calls.push("cancel")
  };
  router = new Router();
  registerShutdownHandlers(router, {
    requireServices: () => ({ shutdown }),
    emitShutdownChanged: () => undefined,
    quit: () => calls.push("quit")
  } as unknown as ServerApp);
});

describe("shutdown handlers", () => {
  const ending: Array<[string, unknown]> = [
    ["shutdown.prepare", PREPARE],
    ["shutdown.force", { token: "t" }],
    ["shutdown.quit", { token: "t" }]
  ];

  for (const [method, params] of ending) {
    test(`${method} rejects a device`, async () => {
      const error = await router.dispatch(method, params, DEVICE).then(
        () => null,
        (reason: unknown) => reason as { code?: string }
      );
      expect(error?.code).toBe("forbidden");
      expect(calls).toEqual([]);
    });

    test(`${method} runs for the owner`, async () => {
      await router.dispatch(method, params, OWNER);
      expect(calls).toEqual([method.slice("shutdown.".length)]);
    });
  }
});
