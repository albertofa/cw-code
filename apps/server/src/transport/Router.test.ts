import { describe, expect, test } from "bun:test";
import { Router, toRpcError, type CallContext } from "./Router.js";

const ctx: CallContext = { clientId: "c1", client: "web", auth: { kind: "owner" } };

describe("Router", () => {
  test("dispatches params and context to the handler", async () => {
    const router = new Router();
    router.handle("sum", (params, callCtx) => ({ total: (params as number[]).reduce((a, b) => a + b, 0), who: callCtx.clientId }));
    expect(router.has("sum")).toBe(true);
    expect(await router.dispatch("sum", [1, 2, 3], ctx)).toEqual({ total: 6, who: "c1" });
  });

  test("awaits async handlers", async () => {
    const router = new Router();
    router.handle("later", async () => "done");
    expect(await router.dispatch("later", undefined, ctx)).toBe("done");
  });

  test("rejects duplicate registration", () => {
    const router = new Router();
    router.handle("a", () => 1);
    expect(() => router.handle("a", () => 2)).toThrow("already registered");
  });

  test("rejects unknown methods with a coded error", async () => {
    const router = new Router();
    expect(router.has("nope")).toBe(false);
    const error = await router.dispatch("nope", undefined, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("unknown method 'nope'");
    expect((error as { code?: string }).code).toBe("unknown-method");
  });

  test("turns synchronous handler throws into rejections", async () => {
    const router = new Router();
    router.handle("boom", () => {
      throw new Error("sync failure");
    });
    await expect(router.dispatch("boom", undefined, ctx)).rejects.toThrow("sync failure");
  });
});

describe("toRpcError", () => {
  test("maps an Error to its message without a code", () => {
    expect(toRpcError(new Error("bad"))).toEqual({ message: "bad" });
  });

  test("stringifies non-Error values", () => {
    expect(toRpcError("plain")).toEqual({ message: "plain" });
  });

  test("keeps a string code", () => {
    expect(toRpcError(Object.assign(new Error("x"), { code: "E_THING" }))).toEqual({ message: "x", code: "E_THING" });
  });

  test("ignores a non-string code", () => {
    expect(toRpcError(Object.assign(new Error("x"), { code: 42 }))).toEqual({ message: "x" });
  });
});
