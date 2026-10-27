import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { ServerEndpoint, TokenStorage } from "@cw-code/contracts";
import {
  CONNECTIONS_FILE,
  ConnectionStore,
  LOCAL_PROFILE,
  parseConnectionTestInput,
  parseRemoteProfileInput,
  TOKEN_MAX_LENGTH,
  type ConnectionsFs,
  type TokenCipher
} from "./connections.js";

const USER_DATA = join("/tmp", "cw-user-data");
const FILE = join(USER_DATA, CONNECTIONS_FILE);
const NOW = 1_700_000_000_000;

class MemoryFs implements ConnectionsFs {
  readonly files = new Map<string, string>();

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, data: string): void {
    this.files.set(path, data);
  }

  rename(from: string, to: string): void {
    const data = this.files.get(from);
    if (data === undefined) throw new Error("ENOENT");
    this.files.delete(from);
    this.files.set(to, data);
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
  return new ConnectionStore({
    userDataDir: USER_DATA,
    cipher,
    fs,
    warn: (message) => warnings.push(message),
    createId: () => `remote-${++next}`,
    now: () => NOW
  });
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
    expect(fs.files.get(FILE) ?? "").not.toContain("secret-token");
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

  it("keeps the saved token when an edit omits it and keeps the origin", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const created = connections.save({ name: "Studio", url: "http://studio.lan:4317", token: "first" });
    const edited = connections.save({ id: created.id, name: "Studio 2", url: "http://studio.lan:4317/" });
    expect(edited).toEqual({ id: created.id, kind: "remote", name: "Studio 2", url: "http://studio.lan:4317" });
    expect(store(fs).token(created.id)).toBe("first");
    connections.save({ id: created.id, name: "Studio 2", url: "http://studio.lan:4317", token: "second" });
    expect(store(fs).token(created.id)).toBe("second");
  });

  it("needs a new token when an edit moves the profile to another origin", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const created = connections.save({ name: "Studio", url: "http://studio.lan:4317", token: "first" });
    expect(() => connections.save({ id: created.id, name: "Studio", url: "http://studio.lan:5000" })).toThrow(
      "enter the device token for the new address"
    );
    expect(store(fs).list().profiles[1]).toEqual(created);
    connections.save({ id: created.id, name: "Studio", url: "http://studio.lan:5000", token: "second" });
    expect(store(fs).endpoint(created.id)).toEqual<ServerEndpoint>({ url: "ws://studio.lan:5000/ws", token: "second" });
    connections.save({ id: created.id, name: "Studio", url: "https://cw.example.com/#token=paired" });
    expect(store(fs).token(created.id)).toBe("paired");
  });

  it("lets the active profile change its name and token but not its origin", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const created = connections.save({ name: "Studio", url: "http://studio.lan:4317", token: "first" });
    connections.setActive(created.id);
    connections.save({ id: created.id, name: "Studio 2", url: "http://studio.lan:4317", token: "second" });
    expect(store(fs).endpoint(created.id)).toEqual<ServerEndpoint>({ url: "ws://studio.lan:4317/ws", token: "second" });
    expect(() => connections.save({ id: created.id, name: "Studio 2", url: "http://other.lan:4317", token: "third" })).toThrow("in use");
    expect(store(fs).token(created.id)).toBe("second");
  });

  it("rejects new profiles without a token, bad URLs and edits of This computer", () => {
    const connections = store(new MemoryFs());
    expect(() => connections.save({ name: "No token", url: "http://a.lan" })).toThrow("device token");
    expect(() => connections.save({ name: "Bad", url: "ftp://a.lan", token: "x" })).toThrow("invalid server address");
    expect(() => connections.save({ name: "", url: "http://a.lan", token: "x" })).toThrow("name");
    expect(() => connections.save({ id: "local", name: "Me", url: "http://a.lan", token: "x" })).toThrow("This computer");
    expect(() => connections.save({ id: "missing", name: "Gone", url: "http://a.lan", token: "x" })).toThrow("no longer exists");
    expect(() => connections.save({ name: "Long", url: `http://a.lan/#token=${"t".repeat(TOKEN_MAX_LENGTH + 1)}` })).toThrow("at most");
  });

  it("removes inactive profiles and refuses the active one and This computer", () => {
    const fs = new MemoryFs();
    const connections = store(fs);
    const first = connections.save({ name: "One", url: "http://one.lan", token: "1" });
    const second = connections.save({ name: "Two", url: "http://two.lan", token: "2" });
    connections.setActive(first.id);
    connections.remove(second.id);
    expect(connections.activeId).toBe(first.id);
    expect(() => connections.remove(first.id)).toThrow("in use");
    connections.setActive("local");
    connections.remove(first.id);
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
    const broken: TokenCipher = {
      ...reversingCipher(),
      decrypt: () => {
        throw new Error("keyring locked");
      }
    };
    expect(() => store(fs, broken).endpoint(profile.id)).toThrow("could not be decrypted");
  });

  it("moves a corrupt or future file aside, uses the defaults and reports why", () => {
    const cases: Array<[string, string]> = [
      ['{"remotes": [{"token": "quoted-secret"', "not valid JSON"],
      [JSON.stringify({ version: 2, activeId: "local", remotes: [] }), "different cw-code version"],
      [JSON.stringify([]), "unexpected shape"]
    ];
    for (const [content, reason] of cases) {
      const fs = new MemoryFs();
      fs.files.set(FILE, content);
      const warnings: string[] = [];
      const list = store(fs, reversingCipher(), warnings).list();
      expect(list.profiles).toEqual([LOCAL_PROFILE]);
      expect(list.activeId).toBe("local");
      expect(list.warning).toContain(reason);
      expect(list.warning).toContain(`${CONNECTIONS_FILE}.bad-${NOW}`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain("quoted-secret");
      expect(fs.files.has(FILE)).toBe(false);
      expect(fs.files.get(`${FILE}.bad-${NOW}`)).toBe(content);
    }
  });

  it("drops malformed remotes and an unknown active id", () => {
    const fs = new MemoryFs();
    const good = { id: "a", name: "A", url: "http://a.lan", token: { scheme: "plain", data: Buffer.from("t").toString("base64") } };
    fs.files.set(FILE, JSON.stringify({ version: 1, activeId: "ghost", remotes: [good, { id: "b", name: "B" }, { ...good, id: "local" }] }));
    const list = store(fs).list();
    expect(list.activeId).toBe("local");
    expect(list.profiles.map((profile) => profile.id)).toEqual(["local", "a"]);
    expect(list.warning).toBeUndefined();
  });

  it("reports basic token storage from the cipher", () => {
    expect(store(new MemoryFs(), reversingCipher("basic")).list().tokenStorage).toBe("basic");
  });

  it("hands a saved token to a test only for the profile's own origin", () => {
    const connections = store(new MemoryFs());
    const profile = connections.save({ name: "Studio", url: "https://studio.lan:4317/cw", token: "secret" });
    expect(connections.testToken(profile.id, "https://studio.lan:4317/other")).toBe("secret");
    expect(connections.testToken(profile.id, "wss://studio.lan:4317/cw/ws")).toBe("secret");
    expect(connections.testToken(profile.id, "https://evil.example.com")).toBeNull();
    expect(connections.testToken(profile.id, "http://studio.lan:4317/cw")).toBeNull();
    expect(connections.testToken(profile.id, "not a url")).toBeNull();
    expect(connections.testToken("missing", "https://studio.lan:4317")).toBeNull();
  });
});

describe("IPC input parsing", () => {
  it("trims fields and caps their lengths", () => {
    expect(parseRemoteProfileInput({ name: " A ", url: " http://a.lan ", token: "  " })).toEqual({ name: "A", url: "http://a.lan" });
    expect(() => parseRemoteProfileInput({ name: "A", url: "http://a.lan", token: "t".repeat(TOKEN_MAX_LENGTH + 1) })).toThrow("at most");
    expect(() => parseRemoteProfileInput({ name: "A", url: `http://a.lan/${"p".repeat(3000)}` })).toThrow("at most");
    expect(() => parseConnectionTestInput({ url: "http://a.lan", token: "t".repeat(TOKEN_MAX_LENGTH + 1) })).toThrow("at most");
    expect(parseConnectionTestInput({ url: "http://a.lan", id: "x" })).toEqual({ url: "http://a.lan", id: "x" });
    expect(parseConnectionTestInput(null)).toEqual({ url: "" });
  });
});
