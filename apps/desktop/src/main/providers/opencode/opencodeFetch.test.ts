import { describe, expect, it, vi, afterEach } from "vitest";
import {
  OPENCODE_DIRECTORY_HEADER,
  OPENCODE_NO_TIMEOUT,
  OpencodeConnectionError,
  isConnectionError,
  isTimeoutError,
  opencodeFetch,
  withDirectoryQuery
} from "./opencodeFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isConnectionError", () => {
  it("flags undici fetch failures and refusals", () => {
    expect(isConnectionError(new Error("fetch failed"))).toBe(true);
    expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:41000"))).toBe(true);
    expect(isConnectionError(new OpencodeConnectionError("dead"))).toBe(true);
  });

  it("does not flag timeouts or aborts as connection errors", () => {
    expect(isConnectionError(new Error("opencode request timed out after 30000ms"))).toBe(false);
    expect(isConnectionError(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

describe("isTimeoutError", () => {
  it("flags abort and timeout messages", () => {
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTimeoutError(new Error("timed out"))).toBe(true);
  });
});

describe("opencodeFetch", () => {
  it("wraps connection refusals in OpencodeConnectionError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(opencodeFetch("http://127.0.0.1:41001/session", { port: 41001 })).rejects.toBeInstanceOf(
      OpencodeConnectionError
    );
  });

  it("times out slow servers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    await expect(opencodeFetch("http://127.0.0.1:41002/session", { timeoutMs: 20, port: 41002 })).rejects.toThrow(
      /timed out/
    );
  });

  it("respects an external abort signal without reporting a timeout", async () => {    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const pending = opencodeFetch("http://127.0.0.1:41003/event", {
      signal: controller.signal,
      timeoutMs: 0,
      port: 41003
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
  });
  it("never aborts slow requests when the timeout is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60))
      )
    );
    const res = await opencodeFetch("http://127.0.0.1:41004/session/native-1/message", {
      method: "POST",
      timeoutMs: OPENCODE_NO_TIMEOUT,
      port: 41004
    });
    expect(res.ok).toBe(true);
  });

  it("sends the directory routing header without dropping other headers", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return Promise.resolve({ ok: true });
      })
    );
    await opencodeFetch("http://127.0.0.1:41005/session", {
      headers: { Authorization: "auth" },
      directory: "C:\\proj\\wt",
      port: 41005
    });
    expect(seen).toHaveLength(1);
    expect((seen[0].init?.headers as Record<string, string>)[OPENCODE_DIRECTORY_HEADER]).toBe("C:\\proj\\wt");
    expect((seen[0].init?.headers as Record<string, string>).Authorization).toBe("auth");
  });
});

describe("withDirectoryQuery", () => {
  it("appends and merges the directory query parameter", () => {
    expect(withDirectoryQuery("http://127.0.0.1:1/session", "C:\\a b")).toBe(
      "http://127.0.0.1:1/session?directory=C%3A%5Ca%20b"
    );
    expect(withDirectoryQuery("http://127.0.0.1:1/session?limit=50", "/x")).toBe(
      "http://127.0.0.1:1/session?limit=50&directory=%2Fx"
    );
  });
});
