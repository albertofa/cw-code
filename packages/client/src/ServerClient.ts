import type { ClientKind, ClientMessage, ServerEndpoint, ServerMessage } from "@cw-code/contracts";
import { CLOSE_PROTOCOL_MISMATCH, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { isValidTopic, MAX_TOPICS_PER_CALL } from "@cw-code/shared/topics";

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

function chunk(topics: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_CALL) batches.push(topics.slice(i, i + MAX_TOPICS_PER_CALL));
  return batches;
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
  private closeFailure: ServerCallError | null = null;
  private connecting: Promise<Welcome> | null = null;
  private abortConnect: ((error: ServerCallError) => void) | null = null;
  private nextId = 1;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private stateListeners = new Set<(state: ConnectionState, previous: ConnectionState) => void>();
  private topicRefs = new Map<string, number>();
  private sentTopics = new Set<string>();
  private failedTopics = new Set<string>();
  private topicCallIds = new Map<string, number>();
  private flushScheduled = false;

  constructor(private readonly options: ServerClientOptions) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  get lastError(): ServerCallError | null {
    return this.closeFailure;
  }

  connect(): Promise<Welcome> {
    if (this.connecting) return this.connecting;
    if (this.currentState === "open" && this.welcome) return Promise.resolve(this.welcome);
    if (this.currentState === "reconnecting") return this.reconnectNow();
    this.disposed = false;
    this.setState("connecting");
    return this.track(this.establish());
  }

  private track(attempt: Promise<Welcome>): Promise<Welcome> {
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = null;
    });
    this.connecting = tracked;
    return tracked;
  }

  private reconnectNow(): Promise<Welcome> {
    if (this.connecting) return this.connecting;
    this.clearRetryTimer();
    return this.track(
      this.resolveEndpoint().then(
        (endpoint) => this.openSocket(endpoint),
        (error: unknown) => {
          if (!this.disposed) this.scheduleReconnect();
          throw error;
        }
      )
    );
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

  get topics(): string[] {
    return [...this.topicRefs.keys()].sort();
  }

  subscribe(topics: readonly string[]): () => void {
    const unique = [...new Set(topics)];
    for (const topic of unique) {
      if (!isValidTopic(topic) || topic.startsWith("pty/")) {
        throw new ServerCallError(`invalid topic "${topic}": pty topics are managed by pty.open/pty.detach`, "invalid-topic");
      }
    }
    for (const topic of unique) this.topicRefs.set(topic, (this.topicRefs.get(topic) ?? 0) + 1);
    this.scheduleFlush();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const topic of unique) {
        const count = (this.topicRefs.get(topic) ?? 0) - 1;
        if (count > 0) this.topicRefs.set(topic, count);
        else {
          this.topicRefs.delete(topic);
          this.failedTopics.delete(topic);
        }
      }
      this.scheduleFlush();
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

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushTopics();
    });
  }

  private flushTopics(): void {
    const socket = this.liveSocket();
    if (!socket) return;
    const added = [...this.topicRefs.keys()].filter((topic) => !this.sentTopics.has(topic) && !this.failedTopics.has(topic));
    const removed = [...this.sentTopics].filter((topic) => !this.topicRefs.has(topic));
    for (const topic of removed) this.sentTopics.delete(topic);
    for (const batch of chunk(removed)) this.post(socket, { t: "call", method: "topics.unsubscribe", params: { topics: batch } });
    this.postSubscribe(socket, added);
  }

  private resubscribe(socket: WebSocket): void {
    this.sentTopics.clear();
    this.failedTopics.clear();
    this.postSubscribe(socket, [...this.topicRefs.keys()]);
  }

  private postSubscribe(socket: WebSocket, topics: string[]): void {
    for (const batch of chunk(topics)) {
      const id = this.nextId++;
      for (const topic of batch) {
        this.sentTopics.add(topic);
        this.topicCallIds.set(topic, id);
      }
      const settled = (): string[] => {
        const owned = batch.filter((topic) => this.topicCallIds.get(topic) === id);
        for (const topic of owned) this.topicCallIds.delete(topic);
        return owned;
      };
      this.pending.set(id, {
        resolve: () => void settled(),
        reject: (error) => {
          const disconnected = error.code === "disconnected";
          for (const topic of settled()) {
            this.sentTopics.delete(topic);
            if (!disconnected) this.failedTopics.add(topic);
          }
          if (!disconnected) console.warn(`[ServerClient] topics.subscribe failed: ${error.message}`);
        }
      });
      this.post(socket, { t: "call", id, method: "topics.subscribe", params: { topics: batch } });
    }
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
      let socket: WebSocket;
      try {
        socket = new Impl(endpoint.url);
      } catch (error) {
        reject(new ServerCallError(`could not open ${endpoint.url}: ${describe(error)}`, "connect-failed"));
        if (this.currentState === "reconnecting" && !this.disposed) this.scheduleReconnect();
        return;
      }
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
          this.closeFailure = null;
          this.welcome = { serverVersion: message.serverVersion, clientId: message.clientId };
          this.resubscribe(socket);
          this.setState("open");
          resolve(this.welcome);
          return;
        }
        if (!welcomed) {
          console.warn("[ServerClient] ignoring server message received before welcome");
          return;
        }
        if (message.t === "result") this.settle(message);
        else if (message.t === "event") this.dispatch(message.channel, message.payload);
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.welcome = null;
        this.abortConnect = null;
        this.closeFailure = closeError(event.code, event.reason);
        this.rejectPending();
        if (!welcomed) reject(this.closeFailure);
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
      this.reconnectNow().catch(() => undefined);
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
