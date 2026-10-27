import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ServerEndpoint, ServerInfo, TokenStorage } from "@cw-code/contracts";
import { ServerCallError } from "@cw-code/client";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import {
  CONNECTIONS_FILE,
  ConnectionStore,
  infoUrl,
  LOCAL_PROFILE,
  testConnection,
  type ConnectionProbe,
  type ConnectionsFs,
  type TokenCipher
} from "./connections.js";

const USER_DATA = join("/tmp", "cw-user-data");
const FILE = join(USER_DATA, CONNECTIONS_FILE);
const INFO: ServerInfo = { app: "cw-code", version: "1.2.3", protocol: PROTOCOL_VERSION };

class MemoryFs implements ConnectionsFs {
  readonly files = new Map<string, string>();

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, data: string): void {
    this.files.set(path, data);
  }
}

function reversingCipher(storage: TokenStorage = "os"): TokenCipher {
  return {
    storage: () => storage,
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join("")}`, "utf8"),
    decrypt: (data) => {
      const text = Buffer.from(data).toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
      return [...text.slice(4)].reverse().join("");
    }
  };
}

function store(fs: MemoryFs, cipher: TokenCipher = reversingCipher(), warnings: string[] = []): ConnectionStore {
  let next = 0;
  return new ConnectionStore({ userDataDir: USER_DATA, cipher, fs, warn: (message) => warnings.push(message), createId: () => `remote-${++next}` });
}

function storedDocument(fs: MemoryFs): { activeId: string; remotes: Array<{ id: string; url: string; token: { scheme: string; data: string } }> } {
  return JSON.parse(fs.files.get(FILE) ?? "null");
}

describe("ConnectionStore", () => {
  it("starts with only This computer", () => {
    expect(store(new MemoryFs()).list()).toEqual({ activeId: "local", profiles: [LOCAL_PROFILE], tokenStorage: "os" });
  });

  it("round-trips a saved profile through the file with an encrypted token", () => {
    const fs = new MemoryFs();
    const profile = store(fs).save({ name: " Studio ", url: "http://studio.lan:4317/", token: "secret-token" });
    expect(profile).toEqual({ id: "remote-1", kind: "remote", name: "Studio", url: "http://studio.lan:4317" });
    const raw = fs.files.get(FILE) ?? "";
    expect(raw).not.toContain("secret-token");
    expect(storedDocument(fs).remotes[0].token.scheme).toBe("safeStorage");

    const reloaded = store(fs);
    expect(reloaded.list().profiles).toEqual([LOCAL_PROFILE, profile]);
    expect(reloaded.token("remote-1")).toBe("secret-token");
    expect(reloaded.endpoint("remote-1")).toEqual<ServerEndpoint>({ url: "ws://studio.lan:4317/ws", token: "secret-token" });
  });

  it("takes the token from a pairing link when none is typed", () => {
    const fs = new MemoryFs();
    const profile = store(fs).save({ name: "Paired", url: "https://cw.example.com/#token=from-link" });
    expect(profile.kind === "remote" && profile.url).toBe("https://cw.example.com");
    expect(store(fs).token(profile.id)).toBe("from-link");
  });

  it("keeps the saved token when an edit omits it", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const created = connections.save({ name: "Studio", url: "http://studio.lan:4317", token: "first" });
    const edited = connections.save({ id: created.id, name: "Studio 2", url: "http://studio.lan:5000" });
    expect(edited).toEqual({ id: created.id, kind: "remote", name: "Studio 2", url: "http://studio.lan:5000" });
    expect(store(fs).token(created.id)).toBe("first");
    connections.save({ id: created.id, name: "Studio 2", url: "http://studio.lan:5000", token: "second" });
    expect(store(fs).token(created.id)).toBe("second");
  });

  it("rejects new profiles without a token, bad URLs and edits of This computer", () => {
    const connections = store(new MemoryFs());
    expect(() => connections.save({ name: "No token", url: "http://a.lan" })).toThrow("device token");
    expect(() => connections.save({ name: "Bad", url: "ftp://a.lan", token: "x" })).toThrow("invalid server address");
    expect(() => connections.save({ name: "", url: "http://a.lan", token: "x" })).toThrow("name");
    expect(() => connections.save({ id: "local", name: "Me", url: "http://a.lan", token: "x" })).toThrow("This computer");
    expect(() => connections.save({ id: "missing", name: "Gone", url: "http://a.lan", token: "x" })).toThrow("no longer exists");
  });

  it("falls back to This computer when the active profile is removed", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const first = connections.save({ name: "One", url: "http://one.lan", token: "1" });
    const second = connections.save({ name: "Two", url: "http://two.lan", token: "2" });
    connections.setActive(first.id);
    connections.remove(second.id);
    expect(connections.activeId).toBe(first.id);
    connections.remove(first.id);
    expect(connections.activeId).toBe("local");
    expect(store(fs).list()).toEqual({ activeId: "local", profiles: [LOCAL_PROFILE], tokenStorage: "os" });
    expect(() => connections.remove("local")).toThrow();
  });

  it("stores tokens with the plain scheme when encryption is unavailable", () => {
    const fs = new MemoryFs();
    const cipher: TokenCipher = {
      storage: () => "plain",
      encrypt: () => {
        throw new Error("encryption is unavailable");
      },
      decrypt: () => {
        throw new Error("encryption is unavailable");
      }
    };
    const profile = store(fs, cipher).save({ name: "Plain", url: "http://plain.lan", token: "visible" });
    expect(storedDocument(fs).remotes[0].token).toEqual({ scheme: "plain", data: Buffer.from("visible").toString("base64") });
    const reloaded = store(fs, cipher);
    expect(reloaded.list().tokenStorage).toBe("plain");
    expect(reloaded.token(profile.id)).toBe("visible");
  });

  it("explains a token that can no longer be decrypted", () => {
    const fs = new MemoryFs();
    const profile = store(fs).save({ name: "Studio", url: "http://studio.lan", token: "secret" });
    const broken: TokenCipher = { ...reversingCipher(), decrypt: () => { throw new Error("keyring locked"); } };
    expect(() => store(fs, broken).endpoint(profile.id)).toThrow("could not be decrypted");
  });

  it("uses the defaults and warns when the file is corrupt", () => {
    for (const content of ["{not json", JSON.stringify({ version: 2, remotes: [] }), JSON.stringify([])]) {
      const fs = new MemoryFs();
      fs.files.set(FILE, content);
      const warnings: string[] = [];
      expect(store(fs, reversingCipher(), warnings).list()).toEqual({ activeId: "local", profiles: [LOCAL_PROFILE], tokenStorage: "os" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(CONNECTIONS_FILE);
    }
  });

  it("drops malformed remotes and an unknown active id", () => {
    const fs = new MemoryFs();
    const good = { id: "a", name: "A", url: "http://a.lan", token: { scheme: "plain", data: Buffer.from("t").toString("base64") } };
    fs.files.set(FILE, JSON.stringify({ version: 1, activeId: "ghost", remotes: [good, { id: "b", name: "B" }, { ...good, id: "local" }] }));
    const list = store(fs).list();
    expect(list.activeId).toBe("local");
    expect(list.profiles.map((profile) => profile.id)).toEqual(["local", "a"]);
  });

  it("reports basic token storage from the cipher", () => {
    expect(store(new MemoryFs(), reversingCipher("basic")).list().tokenStorage).toBe("basic");
  });
});

function probe(overrides: Partial<ConnectionProbe> & { seen?: string[] } = {}): ConnectionProbe {
  return {
    fetchInfo: overrides.fetchInfo ?? (async (url) => {
      overrides.seen?.push(url);
      return INFO;
    }),
    hello: overrides.hello ?? (async () => undefined)
  };
}

describe("testConnection", () => {
  it("joins the info path below a base path", () => {
    expect(infoUrl("http://host:4317")).toBe("http://host:4317/api/info");
    expect(infoUrl("https://host/cw")).toBe("https://host/cw/api/info");
    expect(infoUrl("https://host/cw/")).toBe("https://host/cw/api/info");
  });

  it("succeeds after the info check and the hello", async () => {
    const seen: string[] = [];
    let endpoint: ServerEndpoint | null = null;
    const result = await testConnection("http://host:4317", "tok", probe({ seen, hello: async (target) => void (endpoint = target) }));
    expect(result).toEqual({ ok: true, info: INFO });
    expect(seen).toEqual(["http://host:4317/api/info"]);
    expect(endpoint).toEqual<ServerEndpoint | null>({ url: "ws://host:4317/ws", token: "tok" });
  });

  it("classifies failures", async () => {
    expect((await testConnection("nope", "tok", probe())).ok).toBe(false);
    expect(await testConnection("nope", "tok", probe())).toMatchObject({ code: "invalid-url" });
    const down = await testConnection("http://host", "tok", probe({ fetchInfo: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(down).toMatchObject({ ok: false, code: "unreachable" });
    const other = await testConnection("http://host", "tok", probe({ fetchInfo: async () => ({ hello: "world" }) }));
    expect(other).toMatchObject({ ok: false, code: "unreachable" });
    const old = await testConnection("http://host", "tok", probe({ fetchInfo: async () => ({ ...INFO, protocol: PROTOCOL_VERSION + 1 }) }));
    expect(old).toMatchObject({ ok: false, code: "protocol-mismatch", info: { protocol: PROTOCOL_VERSION + 1 } });
    const missing = await testConnection("http://host", null, probe());
    expect(missing).toMatchObject({ ok: false, code: "unauthorized" });
    const rejected = await testConnection("http://host", "bad", probe({ hello: async () => { throw new ServerCallError("x", "unauthorized"); } }));
    expect(rejected).toMatchObject({ ok: false, code: "unauthorized", info: INFO });
  });

  it("never echoes the token in a failure message", async () => {
    const result = await testConnection("http://host/#token=hash-secret", null, probe({ hello: async () => { throw new Error("closed"); } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("hash-secret");
  });
});
