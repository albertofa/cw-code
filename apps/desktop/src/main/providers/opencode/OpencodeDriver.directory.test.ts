import { describe, expect, it, vi, afterEach } from "vitest";
import type { AppSettings, ThreadEvent } from "@cw-code/contracts";
import { OpencodeDriver, sameDirectory } from "./OpencodeDriver.js";
import { OPENCODE_DIRECTORY_HEADER } from "./opencodeFetch.js";
import type { OpencodeServerPool } from "./opencodeServerPool.js";

const CWD = "C:\\proj\\worktree-1";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stubFetch(seen: SeenRequest[], createdDirectory: string | undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      if (url.endsWith("/event")) return Promise.resolve({ ok: false, status: 500, body: null });
      if (init?.method === "POST" && url.includes("/message")) {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 20));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
            return createdDirectory === undefined ? { id: "srv-1" } : { id: "srv-1", directory: createdDirectory };
          }
          if (url.includes("/message")) return [];
          return {};
        }
      });
    })
  );
}

function makeDriver(poolOverrides: Partial<Record<string, () => void>> = {}): { driver: OpencodeDriver; events: ThreadEvent[] } {
  const events: ThreadEvent[] = [];
  const pool = {
    ensure: async () => ({ port: 41234, authHeader: "auth" }),
    beginTurn: () => {},
    endTurn: () => {},
    invalidate: () => {},
    dispose: () => {},
    ...poolOverrides
  };
  const driver = new OpencodeDriver(
    (e) => {
      events.push(e);
    },
    () => ({ opencodeBinaryPath: "opencode" }) as AppSettings,
    pool as unknown as OpencodeServerPool
  );
  return { driver, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpencodeDriver directory routing", () => {
  it("creates sessions scoped to the worktree directory", async () => {
    const seen: SeenRequest[] = [];
    stubFetch(seen, CWD);
    const { driver, events } = makeDriver();
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: CWD, prompt: "hello" });
      await new Promise((r) => setTimeout(r, 300));
      const creates = seen.filter((s) => s.method === "POST" && /\/session(\?|$)/.test(s.url));
      expect(creates).toHaveLength(1);
      expect(creates[0].url).toContain(`directory=${encodeURIComponent(CWD)}`);
      expect(creates[0].headers[OPENCODE_DIRECTORY_HEADER]).toBe(CWD);
      expect(events.filter((e) => e.type === "turn.error")).toEqual([]);
    } finally {
      driver.dispose();
    }
  });

  it("sends the directory header on session-scoped requests", async () => {
    const seen: SeenRequest[] = [];
    stubFetch(seen, CWD);
    const { driver } = makeDriver();
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: CWD, prompt: "hello" });
      await new Promise((r) => setTimeout(r, 300));
      const sends = seen.filter((s) => s.method === "POST" && s.url.includes("/message"));
      expect(sends.length).toBeGreaterThan(0);
      for (const s of sends) expect(s.headers[OPENCODE_DIRECTORY_HEADER]).toBe(CWD);
    } finally {
      driver.dispose();
    }
  });

  it("fails the turn when the server ignores the session directory", async () => {
    const seen: SeenRequest[] = [];
    stubFetch(seen, "C:\\elsewhere");
    const { driver, events } = makeDriver();
    try {
      const { turnId } = driver.startTurn({ sessionId: "sess_1", cwd: CWD, prompt: "hello" });
      await new Promise((r) => setTimeout(r, 300));
      const errors = events.filter((e) => e.type === "turn.error");
      expect(errors).toHaveLength(1);
      expect((errors[0] as { turnId: string }).turnId).toBe(turnId);
      expect((errors[0] as { message: string }).message).toContain("ignored the session directory");
    } finally {
      driver.dispose();
    }
  });

  it("fails the turn when the server omits the session directory", async () => {
    const seen: SeenRequest[] = [];
    stubFetch(seen, undefined);
    const { driver, events } = makeDriver();
    try {
      driver.startTurn({ sessionId: "sess_1", cwd: CWD, prompt: "hello" });
      await new Promise((r) => setTimeout(r, 300));
      const errors = events.filter((e) => e.type === "turn.error");
      expect(errors).toHaveLength(1);
      expect((errors[0] as { message: string }).message).toContain("ignored the session directory");
    } finally {
      driver.dispose();
    }
  });
});

describe("sameDirectory", () => {
  it("compares case-insensitively on win32 and ignores trailing slashes", () => {
    expect(sameDirectory("C:\\proj\\wt", "c:\\PROJ\\wt\\")).toBe(process.platform === "win32");
    expect(sameDirectory("C:\\proj\\a", "C:\\proj\\b")).toBe(false);
  });
});
