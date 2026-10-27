import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ConnectionList, ConnectionProfile, ConnectionTestResult, RemoteProfileInput, ServerEndpoint, ServerInfo, TokenStorage } from "@cw-code/contracts";
import { ServerCallError, ServerClient } from "@cw-code/client";
import { INFO_PATH, isServerInfo, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { parseServerAddress } from "@cw-code/shared/serverAddress";

export const CONNECTIONS_FILE = "connections.json";
export const LOCAL_PROFILE_ID = "local";
export const LOCAL_PROFILE: ConnectionProfile = { id: LOCAL_PROFILE_ID, kind: "local", name: "This computer" };
export const CONNECTION_TEST_TIMEOUT_MS = 5_000;

const NAME_MAX_LENGTH = 80;

export interface TokenCipher {
  storage(): TokenStorage;
  encrypt(plain: string): Uint8Array;
  decrypt(data: Uint8Array): string;
}

export interface ConnectionsFs {
  read(path: string): string | null;
  write(path: string, data: string): void;
}

export interface ConnectionStoreOptions {
  userDataDir: string;
  cipher: TokenCipher;
  fs: ConnectionsFs;
  warn?: (message: string) => void;
  createId?: () => string;
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
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.remotes)) throw new Error("unsupported file shape");
  const remotes = parsed.remotes.filter(isStoredRemote);
  const activeId = typeof parsed.activeId === "string" && remotes.some((remote) => remote.id === parsed.activeId) ? parsed.activeId : LOCAL_PROFILE_ID;
  return { version: 1, activeId, remotes };
}

function toProfile(remote: StoredRemote): RemoteProfile {
  return { id: remote.id, kind: "remote", name: remote.name, url: remote.url };
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseRemoteProfileInput(value: unknown): RemoteProfileInput {
  if (!isRecord(value)) throw new Error("a connection needs a name and a URL");
  const id = trimmedString(value.id);
  const token = trimmedString(value.token);
  return { ...(id ? { id } : {}), name: trimmedString(value.name), url: trimmedString(value.url), ...(token ? { token } : {}) };
}

export function parseConnectionTestInput(value: unknown): { url: string; token?: string; id?: string } {
  if (!isRecord(value)) return { url: "" };
  const token = trimmedString(value.token);
  const id = trimmedString(value.id);
  return { url: trimmedString(value.url), ...(token ? { token } : {}), ...(id ? { id } : {}) };
}

export class ConnectionStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly createId: () => string;
  private document: ConnectionsDocument;

  constructor(private readonly options: ConnectionStoreOptions) {
    this.path = join(options.userDataDir, CONNECTIONS_FILE);
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.createId = options.createId ?? randomUUID;
    this.document = this.load();
  }

  get activeId(): string {
    return this.document.activeId;
  }

  list(): ConnectionList {
    return {
      activeId: this.document.activeId,
      profiles: [LOCAL_PROFILE, ...this.document.remotes.map(toProfile)],
      tokenStorage: this.options.cipher.storage()
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
      this.warn(`[connections] could not read ${this.path}: ${errorMessage(error)}; using This computer only`);
      return emptyDocument();
    }
    if (text === null) return emptyDocument();
    try {
      return parseDocument(text);
    } catch (error) {
      this.warn(`[connections] ignoring unreadable ${this.path}: ${errorMessage(error)}; using This computer only`);
      return emptyDocument();
    }
  }

  private persist(next: ConnectionsDocument): void {
    this.options.fs.write(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.document = next;
  }
}

export interface ConnectionProbe {
  fetchInfo(url: string, timeoutMs: number): Promise<unknown>;
  hello(endpoint: ServerEndpoint, timeoutMs: number): Promise<void>;
}

export function infoUrl(httpUrl: string): string {
  return new URL(INFO_PATH.slice(1), httpUrl.endsWith("/") ? httpUrl : `${httpUrl}/`).href;
}

async function fetchInfo(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function hello(endpoint: ServerEndpoint, timeoutMs: number): Promise<void> {
  const client = new ServerClient({ endpoint, client: "desktop-shell", reconnect: false });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ServerCallError(`the server did not answer within ${timeoutMs / 1000}s`, "connect-failed")), timeoutMs);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

export const NETWORK_PROBE: ConnectionProbe = { fetchInfo, hello };

function unreachable(message: string, info?: ServerInfo): ConnectionTestResult {
  return { ok: false, code: "unreachable", message, ...(info ? { info } : {}) };
}

export async function testConnection(
  url: string,
  token: string | null,
  probe: ConnectionProbe = NETWORK_PROBE,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS
): Promise<ConnectionTestResult> {
  const address = parseServerAddress(url);
  if ("error" in address) return { ok: false, code: "invalid-url", message: address.error };
  let body: unknown;
  try {
    body = await probe.fetchInfo(infoUrl(address.httpUrl), timeoutMs);
  } catch (error) {
    return unreachable(`could not reach ${address.httpUrl}: ${errorMessage(error)}`);
  }
  if (!isServerInfo(body)) return unreachable(`${address.httpUrl} does not look like a cw-code server`);
  const info = body;
  if (info.protocol !== PROTOCOL_VERSION) {
    return { ok: false, code: "protocol-mismatch", message: `the server runs cw-code v${info.version} (protocol ${info.protocol})`, info };
  }
  const secret = token ?? address.token;
  if (!secret) return { ok: false, code: "unauthorized", message: "enter a device token for this server", info };
  try {
    await probe.hello({ url: address.wsUrl, token: secret }, timeoutMs);
  } catch (error) {
    const code = error instanceof ServerCallError ? error.code : undefined;
    if (code === "unauthorized") return { ok: false, code: "unauthorized", message: "the server rejected this device token (revoked or mistyped)", info };
    if (code === "protocol-mismatch") return { ok: false, code: "protocol-mismatch", message: `the server runs cw-code v${info.version} (protocol ${info.protocol})`, info };
    return unreachable(`could not open a session on ${address.wsUrl}: ${errorMessage(error)}`, info);
  }
  return { ok: true, info };
}
