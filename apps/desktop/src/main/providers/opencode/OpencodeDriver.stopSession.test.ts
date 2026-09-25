import { describe, expect, it, vi } from "vitest";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver } from "./OpencodeDriver.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

describe("OpencodeDriver stopSession", () => {
  it("invalidates the server for a known session cwd and forgets it", async () => {
    const events: ThreadEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
        if (init?.method === "POST") {
          return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 50));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => (url.includes("/message") ? [] : {})
        });
      })
    );
    try {
      const invalidated: string[] = [];
      const pool = {
        ensure: async () => ({ port: 41234, authHeader: "auth" }),
        beginTurn: () => {},
        endTurn: () => {},
        invalidate: (cwd: string) => {
          invalidated.push(cwd);
        },
        dispose: () => {}
      };
      const driver = new OpencodeDriver(
        (e) => {
          events.push(e);
        },
        () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
        pool as unknown as OpencodeServerPool
      );
      try {
        driver.startTurn({ sessionId: "sess_1", cwd: "C:\\proj", prompt: "hello", resumeCursor: "native-1" });
        await new Promise((r) => setTimeout(r, 200));
        driver.stopSession("sess_1");
        expect(invalidated).toEqual(["C:\\proj"]);
        driver.stopSession("sess_1");
        expect(invalidated).toEqual(["C:\\proj"]);
      } finally {
        driver.dispose();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores unknown sessions", () => {
    const invalidate = vi.fn();
    const pool = {
      ensure: async () => ({ port: 1, authHeader: "a" }),
      beginTurn: () => {},
      endTurn: () => {},
      invalidate,
      dispose: () => {}
    };
    const driver = new OpencodeDriver(
      () => {},
      () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
      pool as unknown as OpencodeServerPool
    );
    try {
      driver.stopSession("nope");
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      driver.dispose();
    }
  });
});
