import { describe, expect, it } from "bun:test";
import { LatestVersionCache, packageFor } from "./latestVersion.js";

interface FakeRegistry {
  fetch: typeof fetch;
  calls: string[];
  headers: Array<HeadersInit | undefined>;
  respond(body: unknown, init?: { ok?: boolean }): void;
  hold(): { release(body: unknown): void };
  failWith(error: Error): void;
}

function fakeRegistry(): FakeRegistry {
  const calls: string[] = [];
  const headers: Array<HeadersInit | undefined> = [];
  let handler: () => Promise<Response> = async () => Response.json({ version: "1.0.0" });
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(String(input));
    headers.push(init?.headers);
    return handler();
  };
  return {
    fetch: fake as typeof fetch,
    calls,
    headers,
    respond(body, init) {
      handler = async () => (init?.ok === false ? new Response("nope", { status: 500 }) : Response.json(body));
    },
    hold() {
      let resolve: (response: Response) => void = () => {};
      const gate = new Promise<Response>((r) => {
        resolve = r;
      });
      handler = () => gate;
      return { release: (body) => resolve(Response.json(body)) };
    },
    failWith(error) {
      handler = async () => {
        throw error;
      };
    }
  };
}

function setup() {
  const registry = fakeRegistry();
  const clock = { time: 1_000_000 };
  const cache = new LatestVersionCache({ fetch: registry.fetch, now: () => clock.time });
  return { registry, clock, cache };
}

describe("LatestVersionCache", () => {
  it("requests the encoded package latest endpoint with a JSON accept header", async () => {
    const { registry, cache } = setup();
    registry.respond({ version: "2.1.314" });
    expect(await cache.get("@anthropic-ai/claude-code", { fresh: false })).toBe("2.1.314");
    expect(registry.calls).toEqual(["https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"]);
    expect(registry.headers[0]).toEqual({ accept: "application/json" });
  });

  it("serves a hit from cache for one hour", async () => {
    const { registry, clock, cache } = setup();
    registry.respond({ version: "1.2.3" });
    await cache.get("pkg", { fresh: false });
    clock.time += 59 * 60 * 1000;
    expect(await cache.get("pkg", { fresh: false })).toBe("1.2.3");
    expect(registry.calls).toHaveLength(1);
    clock.time += 2 * 60 * 1000;
    await cache.get("pkg", { fresh: false });
    expect(registry.calls).toHaveLength(2);
  });

  it("caches null for one minute", async () => {
    const { registry, clock, cache } = setup();
    registry.respond({}, { ok: false });
    expect(await cache.get("pkg", { fresh: false })).toBeNull();
    clock.time += 30 * 1000;
    expect(await cache.get("pkg", { fresh: false })).toBeNull();
    expect(registry.calls).toHaveLength(1);
    registry.respond({ version: "1.2.3" });
    clock.time += 31 * 1000;
    expect(await cache.get("pkg", { fresh: false })).toBe("1.2.3");
    expect(registry.calls).toHaveLength(2);
  });

  it("bypasses the cache when fresh", async () => {
    const { registry, cache } = setup();
    registry.respond({ version: "1.0.0" });
    await cache.get("pkg", { fresh: false });
    registry.respond({ version: "1.0.1" });
    expect(await cache.get("pkg", { fresh: true })).toBe("1.0.1");
    expect(await cache.get("pkg", { fresh: false })).toBe("1.0.1");
    expect(registry.calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { registry, cache } = setup();
    const gate = registry.hold();
    const first = cache.get("pkg", { fresh: false });
    const second = cache.get("pkg", { fresh: false });
    gate.release({ version: "3.0.0" });
    expect(await Promise.all([first, second])).toEqual(["3.0.0", "3.0.0"]);
    expect(registry.calls).toHaveLength(1);
  });

  it("does not let a retired in-flight result overwrite a fresh one", async () => {
    const { registry, cache } = setup();
    const stale = registry.hold();
    const older = cache.get("pkg", { fresh: false });
    registry.respond({ version: "1.0.1" });
    expect(await cache.get("pkg", { fresh: true })).toBe("1.0.1");
    stale.release({ version: "1.0.0" });
    await older;
    expect(await cache.get("pkg", { fresh: false })).toBe("1.0.1");
  });

  it("clear drops cached entries and retires in-flight requests", async () => {
    const { registry, cache } = setup();
    registry.respond({ version: "1.0.0" });
    await cache.get("pkg", { fresh: false });
    cache.clear("pkg");
    registry.respond({ version: "1.0.1" });
    expect(await cache.get("pkg", { fresh: false })).toBe("1.0.1");

    const pending = registry.hold();
    const inflight = cache.get("other", { fresh: false });
    cache.clear();
    pending.release({ version: "9.9.9" });
    await inflight;
    registry.respond({ version: "2.0.0" });
    expect(await cache.get("other", { fresh: false })).toBe("2.0.0");
  });

  it("returns null for failures and malformed bodies", async () => {
    const { registry, cache } = setup();
    registry.failWith(new Error("offline"));
    expect(await cache.get("a", { fresh: true })).toBeNull();
    registry.respond({ version: 3 });
    expect(await cache.get("b", { fresh: true })).toBeNull();
    registry.respond({ version: "latest" });
    expect(await cache.get("c", { fresh: true })).toBeNull();
    registry.respond(null);
    expect(await cache.get("d", { fresh: true })).toBeNull();
    registry.respond({}, { ok: false });
    expect(await cache.get("e", { fresh: true })).toBeNull();
  });
});

describe("packageFor", () => {
  it("maps claude and codex to their packages", () => {
    expect(packageFor("claude", "2.1.300")).toBe("@anthropic-ai/claude-code");
    expect(packageFor("codex", null)).toBe("@openai/codex");
  });

  it("never crosses opencode generations", () => {
    expect(packageFor("opencode", "1.18.31")).toBe("opencode-ai");
    expect(packageFor("opencode", "2.0.32")).toBe("@opencode/cli");
    expect(packageFor("opencode", "3.1.0")).toBe("@opencode/cli");
    expect(packageFor("opencode", null)).toBe("opencode-ai");
  });
});
