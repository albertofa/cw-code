import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { ConnectionList, ConnectionProfile, RemoteProfileInput, ServerEndpoint, TokenStorage } from "@cw-code/contracts";
import { parseServerAddress } from "@cw-code/shared/serverAddress";

export const CONNECTIONS_FILE = "connections.json";
export const LOCAL_PROFILE_ID = "local";
export const LOCAL_PROFILE: ConnectionProfile = { id: LOCAL_PROFILE_ID, kind: "local", name: "This computer" };
export const NAME_MAX_LENGTH = 80;
export const URL_MAX_LENGTH = 2048;
export const TOKEN_MAX_LENGTH = 256;
const ID_MAX_LENGTH = 64;

export interface TokenCipher {
  storage(): TokenStorage;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

export interface ConnectionsFs {
  read(path: string): string | null;
  write(path: string, data: string): void;
  rename(from: string, to: string): void;
}

export interface ConnectionStoreOptions {
  userDataDir: string;
  cipher: TokenCipher;
  fs: ConnectionsFs;
  warn?: (message: string) => void;
  createId?: () => string;
  now?: () => number;
}

type TokenScheme = "safeStorage" | "plain";

interface StoredToken {
  scheme: TokenScheme;
  data: string;
}

interface StoredRemote {
  id: string;
  name: string;
  url: string;
  token: StoredToken;
}

interface ConnectionsDocument {
  version: 1;
  activeId: string;
  remotes: StoredRemote[];
}

type RemoteProfile = Extract<ConnectionProfile, { kind: "remote" }>;

class UnreadableConnectionsError extends Error {}

function emptyDocument(): ConnectionsDocument {
  return { version: 1, activeId: LOCAL_PROFILE_ID, remotes: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredToken(value: unknown): value is StoredToken {
  return isRecord(value) && (value.scheme === "safeStorage" || value.scheme === "plain") && typeof value.data === "string";
}

function isStoredRemote(value: unknown): value is StoredRemote {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id !== LOCAL_PROFILE_ID &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    !("error" in parseServerAddress(value.url)) &&
    isStoredToken(value.token)
  );
}

function parseDocument(text: string): ConnectionsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreadableConnectionsError("it is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.remotes)) throw new UnreadableConnectionsError("it has an unexpected shape");
  if (parsed.version !== 1) throw new UnreadableConnectionsError("it was written by a different cw-code version");
  const remotes = parsed.remotes.filter(isStoredRemote);
  const activeId = typeof parsed.activeId === "string" && remotes.some((remote) => remote.id === parsed.activeId) ? parsed.activeId : LOCAL_PROFILE_ID;
  return { version: 1, activeId, remotes };
}

function toProfile(remote: StoredRemote): RemoteProfile {
  return { id: remote.id, kind: "remote", name: remote.name, url: remote.url };
}

function boundedString(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new Error(`the ${label} must be at most ${max} characters`);
  return text;
}

export function parseRemoteProfileInput(value: unknown): RemoteProfileInput {
  if (!isRecord(value)) throw new Error("a connection needs a name and a URL");
  const id = boundedString(value.id, "connection id", ID_MAX_LENGTH);
  const token = boundedString(value.token, "device token", TOKEN_MAX_LENGTH);
  return {
    ...(id ? { id } : {}),
    name: boundedString(value.name, "name", NAME_MAX_LENGTH),
    url: boundedString(value.url, "server address", URL_MAX_LENGTH),
    ...(token ? { token } : {})
  };
}

export function parseConnectionTestInput(value: unknown): { url: string; token?: string; id?: string } {
  if (!isRecord(value)) return { url: "" };
  const token = boundedString(value.token, "device token", TOKEN_MAX_LENGTH);
  const id = boundedString(value.id, "connection id", ID_MAX_LENGTH);
  return { url: boundedString(value.url, "server address", URL_MAX_LENGTH), ...(token ? { token } : {}), ...(id ? { id } : {}) };
}

function originOf(url: string): string | null {
  const address = parseServerAddress(url);
  return "error" in address ? null : new URL(address.httpUrl).origin;
}

export class ConnectionStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly createId: () => string;
  private readonly now: () => number;
  private document: ConnectionsDocument;
  private loadWarning: string | null = null;

  constructor(private readonly options: ConnectionStoreOptions) {
    this.path = join(options.userDataDir, CONNECTIONS_FILE);
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.document = this.load();
  }

  get activeId(): string {
    return this.document.activeId;
  }

  list(): ConnectionList {
    return {
      activeId: this.document.activeId,
      profiles: [LOCAL_PROFILE, ...this.document.remotes.map(toProfile)],
      tokenStorage: this.options.cipher.storage(),
      ...(this.loadWarning ? { warning: this.loadWarning } : {})
    };
  }

  profile(id: string): ConnectionProfile | null {
    if (id === LOCAL_PROFILE_ID) return LOCAL_PROFILE;
    const remote = this.remote(id);
    return remote ? toProfile(remote) : null;
  }

  save(input: RemoteProfileInput): ConnectionProfile {
    const name = input.name.trim();
    if (!name) throw new Error("give the connection a name");
    if (name.length > NAME_MAX_LENGTH) throw new Error(`the name must be at most ${NAME_MAX_LENGTH} characters`);
    const address = parseServerAddress(input.url);
    if ("error" in address) throw new Error(`invalid server address: ${address.error}`);
    if (input.id === LOCAL_PROFILE_ID) throw new Error("This computer cannot be edited");
    const existing = input.id ? this.remote(input.id) : null;
    if (input.id && !existing) throw new Error("this connection no longer exists");
    const plainToken = input.token?.trim() || address.token;
    if (plainToken && plainToken.length > TOKEN_MAX_LENGTH) throw new Error(`the device token must be at most ${TOKEN_MAX_LENGTH} characters`);
    const token = plainToken ? this.sealToken(plainToken) : existing?.token;
    if (!token) throw new Error("enter a device token for this server");
    const remote: StoredRemote = { id: existing?.id ?? this.createId(), name, url: address.httpUrl, token };
    const remotes = existing ? this.document.remotes.map((item) => (item.id === remote.id ? remote : item)) : [...this.document.remotes, remote];
    this.persist({ ...this.document, remotes });
    return toProfile(remote);
  }

  remove(id: string): void {
    if (id === LOCAL_PROFILE_ID) throw new Error("This computer cannot be removed");
    if (!this.remote(id)) return;
    const activeId = this.document.activeId === id ? LOCAL_PROFILE_ID : this.document.activeId;
    this.persist({ ...this.document, activeId, remotes: this.document.remotes.filter((remote) => remote.id !== id) });
  }

  setActive(id: string): void {
    if (!this.profile(id)) throw new Error("this connection no longer exists");
    if (this.document.activeId === id) return;
    this.persist({ ...this.document, activeId: id });
  }

  token(id: string): string {
    const remote = this.remote(id);
    if (!remote) throw new Error("this connection no longer exists");
    return this.openToken(remote);
  }

  testToken(id: string, url: string): string | null {
    const remote = this.remote(id);
    if (!remote) return null;
    const target = originOf(url);
    return target !== null && target === originOf(remote.url) ? this.openToken(remote) : null;
  }

  endpoint(id: string): ServerEndpoint {
    const remote = this.remote(id);
    if (!remote) throw new Error("this connection was removed; choose another one in Connections");
    const address = parseServerAddress(remote.url);
    if ("error" in address) throw new Error(`invalid server address for ${remote.name}: ${address.error}`);
    return { url: address.wsUrl, token: this.openToken(remote) };
  }

  private remote(id: string): StoredRemote | null {
    return this.document.remotes.find((remote) => remote.id === id) ?? null;
  }

  private sealToken(token: string): StoredToken {
    if (this.options.cipher.storage() === "plain") return { scheme: "plain", data: Buffer.from(token, "utf8").toString("base64") };
    return { scheme: "safeStorage", data: Buffer.from(this.options.cipher.encrypt(token)).toString("base64") };
  }

  private openToken(remote: StoredRemote): string {
    const bytes = Buffer.from(remote.token.data, "base64");
    if (remote.token.scheme === "plain") return bytes.toString("utf8");
    try {
      return this.options.cipher.decrypt(bytes);
    } catch (error) {
      throw new Error(`the saved token for ${remote.name} could not be decrypted (${errorMessage(error)}); edit the connection and enter it again`);
    }
  }

  private load(): ConnectionsDocument {
    let text: string | null;
    try {
      text = this.options.fs.read(this.path);
    } catch (error) {
      this.report(`Saved connections could not be read (${errorMessage(error)}). Only This computer is available.`);
      return emptyDocument();
    }
    if (text === null) return emptyDocument();
    try {
      return parseDocument(text);
    } catch (error) {
      const reason = error instanceof UnreadableConnectionsError ? error.message : "it could not be parsed";
      this.report(`${CONNECTIONS_FILE} was ignored because ${reason}. ${this.moveAside()}Only This computer is available.`);
      return emptyDocument();
    }
  }

  private moveAside(): string {
    const target = `${this.path}.bad-${this.now()}`;
    try {
      this.options.fs.rename(this.path, target);
      return `It was moved to ${basename(target)}. `;
    } catch (error) {
      return `It could not be moved aside (${errorMessage(error)}). `;
    }
  }

  private report(message: string): void {
    this.loadWarning = message;
    this.warn(`[connections] ${message}`);
  }

  private persist(next: ConnectionsDocument): void {
    this.options.fs.write(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.document = next;
  }
}
