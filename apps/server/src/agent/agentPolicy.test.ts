import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "@cw-code/contracts";
import { requireOwner } from "../handlers/shared.js";
import { Router, type CallContext } from "../transport/Router.js";
import { assertAgentSettingsPatch, capPermissionMode } from "./agentPolicy.js";

const agent: CallContext = { clientId: "c", client: "mcp", auth: { kind: "agent", sessionId: "s1" } };
const owner: CallContext = { clientId: "c", client: "desktop-ui", auth: { kind: "owner" } };

function routerWith(methods: string[]): Router {
  const router = new Router();
  for (const method of methods) router.handle(method, () => `ran ${method}`);
  return router;
}

describe("Router agent policy", () => {
  test("lets an agent call an allowlisted method", async () => {
    const router = routerWith(["turns.start"]);
    expect(await router.dispatch("turns.start", {}, agent)).toBe("ran turns.start");
  });

  test("rejects a non-allowlisted method for an agent but not for the owner", async () => {
    const router = routerWith(["fs.readFile"]);
    await expect(router.dispatch("fs.readFile", {}, agent)).rejects.toMatchObject({ code: "forbidden" });
    expect(await router.dispatch("fs.readFile", {}, owner)).toBe("ran fs.readFile");
  });

  test("rejects an owner-only method for an agent", async () => {
    const router = new Router();
    router.handle("server.stop", (_params, ctx) => requireOwner(ctx, "stopping the server"));
    await expect(router.dispatch("server.stop", {}, agent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(router.dispatch("server.stop", {}, owner)).resolves.toBeUndefined();
  });
});

describe("capPermissionMode", () => {
  const modes: PermissionMode[] = ["manual", "acceptEdits", "auto", "bypassPermissions"];

  test.each(modes.flatMap((requested, i) => modes.map((caller, j) => [requested, caller, modes[Math.min(i, j)]] as const)))(
    "requested %s with caller %s gives %s",
    (requested, caller, expected) => {
      expect(capPermissionMode(requested, caller)).toBe(expected);
    }
  );

  test("undefined caller is manual", () => {
    expect(capPermissionMode("bypassPermissions", undefined)).toBe("manual");
    expect(capPermissionMode(undefined, undefined)).toBe("manual");
  });

  test("undefined requested inherits the caller mode", () => {
    expect(capPermissionMode(undefined, "auto")).toBe("auto");
  });
});

describe("assertAgentSettingsPatch", () => {
  test.each([["claudeBinaryPath", "/bin/claude"], ["claudeExtraArgs", "--x"], ["keepServerRunning", true]])("rejects %s", (key, value) => {
    expect(() => assertAgentSettingsPatch({ [key]: value })).toThrow(key);
    try {
      assertAgentSettingsPatch({ [key]: value });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("forbidden");
    }
  });

  test("names the first denied key in a mixed patch", () => {
    expect(() => assertAgentSettingsPatch({ claudeDefaultModel: "m", claudeBinaryPath: "x" })).toThrow("claudeBinaryPath");
  });

  test("accepts allowlisted keys", () => {
    expect(() => assertAgentSettingsPatch({ claudeDefaultModel: "opus", holdingHours: 4 })).not.toThrow();
  });
});
