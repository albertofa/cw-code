import type { ClientKind, ClientMessage, ServerEndpoint, ServerMessage } from "@cw-code/contracts";
import { CLOSE_PROTOCOL_MISMATCH, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "@cw-code/shared/protocol";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

interface Welcome {
  serverVersion: string;
  clientId: string;
}

type ResultMessage = Extract<ServerMessage, { t: "result" }>;

const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 5000;
const SOCKET_OPEN = 1;
const FATAL_CLOSE_CODES = new Set([CLOSE_UNAUTHORIZED, CLOSE_PROTOCOL_MISMATCH]);

export class ServerCallError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ServerCallError";
    this.code = code;
  }
}

export interface ServerClientOptions {
  endpoint: ServerEndpoint | (() => Promise<ServerEndpoint>);
  client: ClientKind;
  reconnect?: boolean;
  WebSocketImpl?: typeof WebSocket;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: ServerCallError) => void;
}

function disconnectedError(): ServerCallError {
  return new ServerCallError("server connection lost", "disconnected");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeError(code: number, reason: string): ServerCallError {
  const suffix = reason ? `: ${reason}` : "";
  if (code === CLOSE_UNAUTHORIZED) return new ServerCallError(`server rejected the access token${suffix}`, "unauthorized");
  if (code === CLOSE_PROTOCOL_MISMATCH) return new ServerCallError(`server protocol version mismatch${suffix}`, "protocol-mismatch");
  return new ServerCallError(`could not connect to the server (close code ${code})${suffix}`, "connect-failed");
}

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  switch (message.t) {
    case "welcome":
      return typeof message.serverVersion === "string" && typeof message.clientId === "string" ? (parsed as ServerMessage) : null;
    case "result":
      return typeof message.id === "number" && typeof message.ok === "boolean" ? (parsed as ServerMessage) : null;
    case "event":
      return typeof message.channel === "string" ? (parsed as ServerMessage) : null;
    default:
      return null;
  }
}

export class ServerClient {
  private currentState: ConnectionState = "closed";
  private socket: WebSocket | null = null;
  private welcome: Welcome | null = null;
  private connecting: Promise<Welcome> | null = null;
  private abortConnect: ((error: ServerCallError) => void) | null = null;
  private nextId = 1;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private stateListeners = new Set<(state: ConnectionState, previous: ConnectionState) => void>();

  constructor(private readonly options: ServerClientOptions) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  connect(): Promise<Welcome> {
    if (this.connecting) return this.connecting;
    if (this.currentState === "open" && this.welcome) return Promise.resolve(this.welcome);
    this.disposed = false;
    this.setState("connecting");
    const attempt = this.establish().finally(() => {
      if (this.connecting === attempt) this.connecting = null;
    });
    this.connecting = attempt;
    return attempt;
  }

  private async establish(): Promise<Welcome> {
    try {
      return await this.openSocket(await this.resolveEndpoint());
    } catch (error) {
      this.setState("closed");
      throw error;
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const socket = this.liveSocket();
    if (!socket) return Promise.reject(disconnectedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.post(socket, { t: "call", id, method, params });
    });
  }

  send(method: string, params?: unknown): void {
    const socket = this.liveSocket();
    if (socket) this.post(socket, { t: "call", method, params });
  }

  on(channel: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    return () => {
      this.listeners.get(channel)?.delete(cb);
    };
  }

  onState(cb: (state: ConnectionState, previous: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  close(): void {
    this.disposed = true;
    this.clearRetryTimer();
    const socket = this.socket;
    this.socket = null;
    this.welcome = null;
    this.rejectPending();
    this.abortConnect?.(new ServerCallError("client closed", "connect-failed"));
    this.setState("closed");
    socket?.close();
  }

  private liveSocket(): WebSocket | null {
    const socket = this.socket;
    return this.currentState === "open" && socket && socket.readyState === SOCKET_OPEN ? socket : null;
  }

  private post(socket: WebSocket, message: ClientMessage): void {
    socket.send(JSON.stringify(message));
  }

  private setState(next: ConnectionState): void {
    const previous = this.currentState;
    if (previous === next) return;
    this.currentState = next;
    for (const cb of [...this.stateListeners]) {
      try {
        cb(next, previous);
      } catch (error) {
        console.error("[ServerClient] state listener failed", error);
      }
    }
  }

  private async resolveEndpoint(): Promise<ServerEndpoint> {
    const { endpoint } = this.options;
    try {
      return typeof endpoint === "function" ? await endpoint() : endpoint;
    } catch (error) {
      throw new ServerCallError(`could not resolve the server endpoint: ${describe(error)}`, "connect-failed");
    }
  }

  private openSocket(endpoint: ServerEndpoint): Promise<Welcome> {
    if (this.disposed) return Promise.reject(new ServerCallError("client closed", "connect-failed"));
    const Impl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    return new Promise<Welcome>((resolve, reject) => {
      const socket = new Impl(endpoint.url);
      this.socket = socket;
      this.abortConnect = reject;
      let welcomed = false;

      socket.onopen = () => {
        this.post(socket, { t: "hello", token: endpoint.token, protocol: PROTOCOL_VERSION, client: this.options.client });
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        const message = parseServerMessage(event.data);
        if (!message) {
          console.warn("[ServerClient] ignoring malformed server message");
          return;
        }
        if (message.t === "welcome") {
          if (welcomed) return;
          welcomed = true;
          this.attempt = 0;
          this.abortConnect = null;
          this.welcome = { serverVersion: message.serverVersion, clientId: message.clientId };
          this.setState("open");
          resolve(this.welcome);
          return;
        }
        if (!welcomed) {
          console.warn("[ServerClient] ignoring server message received before welcome");
          return;
        }
        if (message.t === "result") this.settle(message);
        else this.dispatch(message.channel, message.payload);
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.welcome = null;
        this.abortConnect = null;
        this.rejectPending();
        if (!welcomed) reject(closeError(event.code, event.reason));
        if (this.currentState === "connecting") return;
        if (FATAL_CLOSE_CODES.has(event.code) || !this.options.reconnect) {
          this.setState("closed");
          return;
        }
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = Math.min(RETRY_INITIAL_MS * 2 ** this.attempt, RETRY_MAX_MS);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.resolveEndpoint().then(
        (endpoint) => this.openSocket(endpoint).catch(() => undefined),
        () => {
          if (!this.disposed) this.scheduleReconnect();
        }
      );
    }, delay);
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private settle(message: ResultMessage): void {
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if (message.ok) call.resolve(message.value);
    else call.reject(new ServerCallError(message.error.message, message.error.code));
  }

  private rejectPending(): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) call.reject(disconnectedError());
  }

  private dispatch(channel: string, payload: unknown): void {
    for (const cb of [...(this.listeners.get(channel) ?? [])]) {
      try {
        cb(payload);
      } catch (error) {
        console.error(`[ServerClient] listener for "${channel}" failed`, error);
      }
    }
  }
}
