import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { releaseSqliteFiles } from "../../../../tests/testing.js";
import {
  fetchOpencodeGoUsage,
  mapOpencodeGoUsage,
  opencodeV2Tokens,
  readOpencodeGoKey,
  readOpencodeV2Tokens,
  type OpencodeGoUsageDeps
} from "./opencodeAccountUsage.js";

const FAKE_KEY = "fake-test-key";
const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-opencode-auth-"));
  tempDirs.push(dir);
  return dir;
}

function writeAuthJson(home: string, contents: string): void {
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), contents, "utf8");
}

interface CredentialFixture {
  integration: string;
  value: Record<string, unknown>;
  active?: number;
  updated?: number;
}

function writeCredentialDb(dbPath: string, credentials: CredentialFixture[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)"
  );
  const insert = db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)");
  credentials.forEach((c, i) => insert.run(`cred_${i}`, c.integration, "label", JSON.stringify(c.value), c.active ?? null, 1, c.updated ?? 1));
  db.close();
}

function writeV2Credentials(home: string, credentials: CredentialFixture[]): void {
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeCredentialDb(join(dir, "opencode.db"), credentials);
}

const NOW = Date.parse("2026-10-19T00:00:00.000Z");
const FUTURE = NOW + 86_400_000;

function oauth(access: string, expires = FUTURE): Record<string, unknown> {
  return { type: "oauth", methodID: "device", refresh: "fake-refresh", access, expires, metadata: {} };
}

afterEach(() => {
  releaseSqliteFiles();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mapOpencodeGoUsage", () => {
  it("maps a healthy response into windows and a note", () => {
    const state = mapOpencodeGoUsage({
      usage: {
        rolling: { status: "ok", percent: 42, resetsAt: "2026-09-24T12:00:00.000Z" },
        weekly: { status: "ok", percent: 10, resetsAt: "2026-09-28T00:00:00.000Z" },
        monthly: { status: "ok", percent: 5, resetsAt: "2026-10-01T00:00:00.000Z" }
      }
    });
    expect(state).toEqual({
      status: "ok",
      plan: "OpenCode Go",
      windows: [
        { id: "rolling", label: "5-hour", percent: 42, resetsAt: Date.parse("2026-09-24T12:00:00.000Z"), severity: "normal" },
        { id: "weekly", label: "Weekly", percent: 10, resetsAt: Date.parse("2026-09-28T00:00:00.000Z"), severity: "normal" },
        { id: "monthly", label: "Monthly", percent: 5, resetsAt: Date.parse("2026-10-01T00:00:00.000Z"), severity: "normal" }
      ],
      balances: [],
      notes: ["Percent only. Dollar caps depend on the model."]
    });
  });

  it("marks a rate-limited window as blocked regardless of percent", () => {
    const state = mapOpencodeGoUsage({
      usage: {
        rolling: { status: "rate-limited", percent: 30, resetsAt: "2026-09-24T12:00:00.000Z" }
      }
    });
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("expected ok");
    expect(state.windows).toEqual([
      { id: "rolling", label: "5-hour", percent: 30, resetsAt: Date.parse("2026-09-24T12:00:00.000Z"), severity: "blocked" }
    ]);
  });

  it("marks a window at or above 80 percent as a warning", () => {
    const state = mapOpencodeGoUsage({ usage: { weekly: { status: "ok", percent: 85 } } });
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("expected ok");
    expect(state.windows).toEqual([{ id: "weekly", label: "Weekly", percent: 85, severity: "warning" }]);
  });

  it("errors on a response with no recognizable windows", () => {
    expect(mapOpencodeGoUsage({ usage: {} })).toEqual({ status: "error", message: "Unexpected OpenCode Go usage response" });
    expect(mapOpencodeGoUsage(null)).toEqual({ status: "error", message: "Unexpected OpenCode Go usage response" });
    expect(mapOpencodeGoUsage({})).toEqual({ status: "error", message: "Unexpected OpenCode Go usage response" });
  });
});

describe("readOpencodeGoKey", () => {
  it("reports not-found when auth.json is missing", () => {
    const home = tempHome();
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "not-found" });
  });

  it("reports not-found when the opencode-go entry is missing", () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ anthropic: { type: "api", key: "sk-other" } }));
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "not-found" });
  });

  it("reports malformed when auth.json isn't valid JSON", () => {
    const home = tempHome();
    writeAuthJson(home, "{ not json");
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "malformed" });
  });

  it("reports malformed when the opencode-go entry has no string key", () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api" } }));
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "malformed" });
    writeAuthJson(home, JSON.stringify({ "opencode-go": "not-an-object" }));
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "malformed" });
  });

  it("reads the key when the opencode-go entry is present", () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    expect(readOpencodeGoKey({}, home)).toEqual({ status: "found", key: FAKE_KEY });
  });

  it("honours XDG_DATA_HOME over the home directory default", () => {
    const home = tempHome();
    const xdg = tempHome();
    const dir = join(xdg, "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fake-xdg-key" } }), "utf8");
    expect(readOpencodeGoKey({ XDG_DATA_HOME: xdg }, home)).toEqual({ status: "found", key: "fake-xdg-key" });
  });
});

describe("opencodeV2Tokens", () => {
  it("puts unexpired OAuth sign-ins first, active then newest, before Go API keys", () => {
    const rows = [
      { integration_id: "opencode-go", value: JSON.stringify({ type: "api", key: "fake-go-key" }), active: null, time_updated: 9 },
      { integration_id: "opencode", value: JSON.stringify(oauth("fake-old")), active: null, time_updated: 5 },
      { integration_id: "opencode", value: JSON.stringify(oauth("fake-active")), active: 1, time_updated: 1 },
      { integration_id: "opencode", value: JSON.stringify(oauth("fake-new")), active: null, time_updated: 8 }
    ];
    expect(opencodeV2Tokens(rows, NOW)).toEqual(["fake-active", "fake-new", "fake-old", "fake-go-key"]);
  });

  it("skips expired OAuth tokens, other integrations and unparseable values", () => {
    const rows = [
      { integration_id: "opencode", value: JSON.stringify(oauth("fake-expired", NOW - 1)), active: 1, time_updated: 1 },
      { integration_id: "openrouter", value: JSON.stringify({ type: "api", key: "fake-openrouter" }), active: null, time_updated: 1 },
      { integration_id: "opencode-go", value: "{ not json", active: null, time_updated: 1 },
      { integration_id: null, value: JSON.stringify(oauth("fake-orphan")), active: null, time_updated: 1 }
    ];
    expect(opencodeV2Tokens(rows, NOW)).toEqual([]);
  });
});

describe("readOpencodeV2Tokens", () => {
  it("returns nothing when there is no v2 database", async () => {
    expect(await readOpencodeV2Tokens({}, tempHome(), NOW)).toEqual([]);
  });

  it("returns nothing when the database has no credential table", async () => {
    const home = tempHome();
    const dir = join(home, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec("CREATE TABLE session (id text)");
    db.close();
    expect(await readOpencodeV2Tokens({}, home, NOW)).toEqual([]);
  });

  it("reads the credential table from the default data dir", async () => {
    const home = tempHome();
    writeV2Credentials(home, [{ integration: "opencode", value: oauth("fake-access"), active: 1 }]);
    expect(await readOpencodeV2Tokens({}, home, NOW)).toEqual(["fake-access"]);
  });

  it("honours an absolute OPENCODE_DB and a relative one under the data dir", async () => {
    const home = tempHome();
    const elsewhere = join(tempHome(), "custom.db");
    writeCredentialDb(elsewhere, [{ integration: "opencode", value: oauth("fake-absolute") }]);
    expect(await readOpencodeV2Tokens({ OPENCODE_DB: elsewhere }, home, NOW)).toEqual(["fake-absolute"]);

    const dir = join(home, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    writeCredentialDb(join(dir, "opencode-beta.db"), [{ integration: "opencode", value: oauth("fake-relative") }]);
    expect(await readOpencodeV2Tokens({ OPENCODE_DB: "opencode-beta.db" }, home, NOW)).toEqual(["fake-relative"]);
  });
});

describe("fetchOpencodeGoUsage", () => {
  function deps(overrides: Partial<OpencodeGoUsageDeps> = {}): OpencodeGoUsageDeps {
    const home = tempHome();
    return { fetchFn: async () => new Response(null, { status: 500 }), env: {}, home, ...overrides };
  }

  it("returns consent-required without touching the filesystem when the setting is off", async () => {
    let fetchCalled = false;
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(false, {
      fetchFn: async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      },
      env: {},
      home
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "consent-required",
      message: "Allow cw-code to read your OpenCode sign-in or Go key to show plan limits"
    });
    expect(fetchCalled).toBe(false);
  });

  it("returns no-subscription when there is no key", async () => {
    const result = await fetchOpencodeGoUsage(true, deps());
    expect(result).toEqual({ status: "unavailable", reason: "no-subscription", message: "No OpenCode Go subscription found" });
  });

  it("returns an error when auth.json is unreadable, without leaking why", async () => {
    const home = tempHome();
    writeAuthJson(home, "not json");
    const result = await fetchOpencodeGoUsage(true, deps({ home }));
    expect(result).toEqual({ status: "error", message: "Couldn't read OpenCode's auth file" });
  });

  it("maps 401 to key-rejected", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 401 }) }));
    expect(result).toEqual({
      status: "unavailable",
      reason: "key-rejected",
      message: "Run `opencode auth login` and pick OpenCode Go"
    });
  });

  it("maps 403 to no-subscription", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 403 }) }));
    expect(result).toEqual({ status: "unavailable", reason: "no-subscription", message: "No OpenCode Go subscription found" });
  });

  it("maps any other non-200 to an error", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 500 }) }));
    expect(result).toEqual({ status: "error", message: "OpenCode Go usage request failed: 500" });
  });

  it("maps a network throw to an error without echoing the underlying message", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async () => {
          throw new Error(`connect ECONNREFUSED, Authorization: Bearer ${FAKE_KEY}`);
        }
      })
    );
    expect(result).toEqual({ status: "error", message: "Couldn't reach opencode.ai" });
  });

  it("maps a timeout/abort to a dedicated message", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async () => {
          throw new DOMException("The operation was aborted", "TimeoutError");
        }
      })
    );
    expect(result).toEqual({ status: "error", message: "OpenCode Go usage request timed out" });
  });

  it("maps unparseable JSON in a 200 response to an error", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const result = await fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response("not json", { status: 200 }) }));
    expect(result).toEqual({ status: "error", message: "Unexpected OpenCode Go usage response" });
  });

  it("never leaks the key into the mapped result, for every outcome", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    const outcomes = await Promise.all([
      fetchOpencodeGoUsage(false, { fetchFn: async () => new Response(null, { status: 200 }), env: {}, home }),
      fetchOpencodeGoUsage(true, deps()),
      fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 401 }) })),
      fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 403 }) })),
      fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response(null, { status: 500 }) })),
      fetchOpencodeGoUsage(
        true,
        deps({
          home,
          fetchFn: async () => {
            throw new Error(`boom Authorization: Bearer ${FAKE_KEY}`);
          }
        })
      ),
      fetchOpencodeGoUsage(
        true,
        deps({
          home,
          fetchFn: async () => {
            throw new DOMException("timed out", "TimeoutError");
          }
        })
      ),
      fetchOpencodeGoUsage(true, deps({ home, fetchFn: async () => new Response("not json", { status: 200 }) }))
    ]);
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    }
  });

  it("uses the v2 OAuth sign-in when auth.json still holds an expired Go key", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    writeV2Credentials(home, [
      { integration: "opencode-go", value: { type: "api", key: FAKE_KEY } },
      { integration: "opencode", value: oauth("fake-v2-access", Date.now() + 86_400_000), active: 1 }
    ]);
    const seen: string[] = [];
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async (_url, init) => {
          const auth = new Headers(init?.headers).get("Authorization") ?? "";
          seen.push(auth);
          if (auth !== "Bearer fake-v2-access") return new Response(null, { status: 401 });
          return Response.json({ usage: { weekly: { status: "ok", percent: 12 } } });
        }
      })
    );
    expect(seen).toEqual(["Bearer fake-v2-access"]);
    expect(result.status).toBe("ok");
  });

  it("falls through to the next credential when one is rejected", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    writeV2Credentials(home, [{ integration: "opencode", value: oauth("fake-revoked", Date.now() + 86_400_000) }]);
    const seen: string[] = [];
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async (_url, init) => {
          const auth = new Headers(init?.headers).get("Authorization") ?? "";
          seen.push(auth);
          if (auth === "Bearer fake-revoked") return new Response(null, { status: 401 });
          return Response.json({ usage: { weekly: { status: "ok", percent: 12 } } });
        }
      })
    );
    expect(seen).toEqual(["Bearer fake-revoked", `Bearer ${FAKE_KEY}`]);
    expect(result.status).toBe("ok");
  });

  it("falls through past a signed-in account without a Go plan to a working Go key", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    writeV2Credentials(home, [{ integration: "opencode", value: oauth("fake-no-plan", Date.now() + 86_400_000), active: 1 }]);
    const seen: string[] = [];
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async (_url, init) => {
          const auth = new Headers(init?.headers).get("Authorization") ?? "";
          seen.push(auth);
          if (auth === "Bearer fake-no-plan") return new Response(null, { status: 403 });
          return Response.json({ usage: { weekly: { status: "ok", percent: 12 } } });
        }
      })
    );
    expect(seen).toEqual(["Bearer fake-no-plan", `Bearer ${FAKE_KEY}`]);
    expect(result.status).toBe("ok");
  });

  it("reports no-subscription over key-rejected when every credential fails", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    writeV2Credentials(home, [{ integration: "opencode", value: oauth("fake-no-plan", Date.now() + 86_400_000), active: 1 }]);
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async (_url, init) =>
          new Response(null, { status: new Headers(init?.headers).get("Authorization") === "Bearer fake-no-plan" ? 403 : 401 })
      })
    );
    expect(result).toEqual({ status: "unavailable", reason: "no-subscription", message: "No OpenCode Go subscription found" });
  });

  it("reports key-rejected only after every credential is rejected", async () => {
    const home = tempHome();
    writeAuthJson(home, JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY } }));
    writeV2Credentials(home, [{ integration: "opencode", value: oauth("fake-revoked", Date.now() + 86_400_000) }]);
    let calls = 0;
    const result = await fetchOpencodeGoUsage(
      true,
      deps({
        home,
        fetchFn: async () => {
          calls++;
          return new Response(null, { status: 401 });
        }
      })
    );
    expect(calls).toBe(2);
    expect(result).toEqual({ status: "unavailable", reason: "key-rejected", message: "Run `opencode auth login` and pick OpenCode Go" });
  });
});
