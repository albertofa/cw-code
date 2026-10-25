import type { ClientKind, ClientMessage, ServerMessage } from "@cw-code/contracts";
import {
  CLOSE_CLIENT_TOO_SLOW,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_MISMATCH,
  CLOSE_SERVER_STOPPING,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION
} from "@cw-code/shared/protocol";
import { randomUUID } from "node:crypto";
import { connectHost } from "./bindPolicy.js";
import { toRpcError, type CallContext, type ClientAuth, type Router } from "./Router.js";

export interface WsServerOptions {
  host: string;
  port: number;
  authorize(token: string): ClientAuth | null;
  isOriginAllowed?(origin: string | null, hostHeader: string | null): boolean;
  onOriginRejected?(origin: string | null): void;
  version: string;
  router: Router;
  helloTimeoutMs?: number;
}

interface SocketData {
  ctx: CallContext | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

type Socket = Bun.ServerWebSocket<SocketData>;
export type FrameSink = Pick<Bun.ServerWebSocket<unknown>, "readyState" | "send" | "close">;
type HelloMessage = Extract<ClientMessage, { t: "hello" }>;
type CallMessage = Extract<ClientMessage, { t: "call" }>;

const WS_PATH = "/ws";
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const SOCKET_OPEN = 1;
const SEND_DROPPED = 0;
const MAX_TOKEN_LENGTH = 256;
const DESKTOP_CLIENT_KINDS = new Set<string>(["desktop-ui", "desktop-shell"] satisfies ClientKind[]);
const CLIENT_KINDS = new Set<string>(["desktop-ui", "desktop-shell", "web"] satisfies ClientKind[]);

function parseJsonObject(raw: string | Buffer): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asHello(message: Record<string, unknown> | null): HelloMessage | null {
  if (message?.t !== "hello") return null;
  if (typeof message.token !== "string" || typeof message.protocol !== "number") return null;
  if (typeof message.client !== "string" || !CLIENT_KINDS.has(message.client)) return null;
  return message as HelloMessage;
}

function asCall(message: Record<string, unknown>): CallMessage | null {
  if (message.t !== "call" || typeof message.method !== "string") return null;
  if (message.id !== undefined && typeof message.id !== "number") return null;
  return message as CallMessage;
}

export function sendRaw(ws: FrameSink, data: string): void {
  if (ws.readyState !== SOCKET_OPEN) return;
  let sent: number;
  try {
    sent = ws.send(data);
  } catch (error) {
    console.warn(`could not send to client: ${(error as Error).message}`);
    return;
  }
  if (sent !== SEND_DROPPED) return;
  console.warn("closing a client that is too slow to keep up with server messages");
  ws.close(CLOSE_CLIENT_TOO_SLOW, "client too slow");
}

export function wsUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${urlHost}:${port}${WS_PATH}`;
}

export class WsServer {
  private server: Bun.Server<SocketData> | null = null;
  private sockets = new Set<Socket>();
  private socketsByClient = new Map<string, Socket>();
  private acceptedListeners = new Set<(ctx: CallContext) => void>();
  private closedListeners = new Set<(ctx: CallContext) => void>();
  private readonly helloTimeoutMs: number;

  constructor(private readonly options: WsServerOptions) {
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  start(): { port: number; url: string } {
    if (this.server) throw new Error("server already started");
    const server = Bun.serve<SocketData>({
      hostname: this.options.host,
      port: this.options.port,
      fetch: (req, srv) => {
        if (new URL(req.url).pathname !== WS_PATH) return new Response("not found", { status: 404 });
        const origin = req.headers.get("origin");
        if (this.options.isOriginAllowed && !this.options.isOriginAllowed(origin, req.headers.get("host"))) {
          this.options.onOriginRejected?.(origin);
          return new Response("forbidden", { status: 403 });
        }
        if (srv.upgrade(req, { data: { ctx: null, helloTimer: null } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        maxPayloadLength: MAX_PAYLOAD_BYTES,
        closeOnBackpressureLimit: true,
        open: (ws) => this.onOpen(ws),
        message: (ws, raw) => this.onMessage(ws, raw),
        close: (ws) => this.onClose(ws),
      },
    });
    this.server = server;
    const port = server.port ?? this.options.port;
    return { port, url: wsUrl(connectHost(this.options.host), port) };
  }

  broadcast(channel: string, payload: unknown, accept?: (ctx: CallContext) => boolean): void {
    const data = JSON.stringify({ t: "event", channel, payload } satisfies ServerMessage);
    for (const ws of [...this.sockets]) {
      const ctx = ws.data.ctx;
      if (ctx && (!accept || accept(ctx))) sendRaw(ws, data);
    }
  }

  sendEvent(clientIds: Iterable<string>, channel: string, payload: unknown): void {
    this.sendTo(clientIds, JSON.stringify({ t: "event", channel, payload } satisfies ServerMessage));
  }

  sendTo(clientIds: Iterable<string>, frame: string): void {
    for (const clientId of clientIds) {
      const ws = this.socketsByClient.get(clientId);
      if (ws) sendRaw(ws, frame);
    }
  }

  isConnected(clientId: string): boolean {
    return this.socketsByClient.has(clientId);
  }

  closeClients(match: (ctx: CallContext) => boolean, code: number, reason: string): number {
    let closed = 0;
    for (const ws of [...this.sockets]) {
      const ctx = ws.data.ctx;
      if (!ctx || !match(ctx)) continue;
      ws.close(code, reason);
      closed += 1;
    }
    return closed;
  }

  onClientAccepted(cb: (ctx: CallContext) => void): () => void {
    this.acceptedListeners.add(cb);
    return () => {
      this.acceptedListeners.delete(cb);
    };
  }

  onClientClosed(cb: (ctx: CallContext) => void): () => void {
    this.closedListeners.add(cb);
    return () => {
      this.closedListeners.delete(cb);
    };
  }

  clients(): CallContext[] {
    return [...this.sockets].flatMap((ws) => (ws.data.ctx ? [ws.data.ctx] : []));
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const ws of [...this.sockets]) ws.close(CLOSE_SERVER_STOPPING, "server stopping");
    await server.stop(true);
  }

  private onOpen(ws: Socket): void {
    this.sockets.add(ws);
    ws.data.helloTimer = setTimeout(() => {
      ws.data.helloTimer = null;
      if (!ws.data.ctx) ws.close(CLOSE_HELLO_TIMEOUT, "hello timeout");
    }, this.helloTimeoutMs);
  }

  private onClose(ws: Socket): void {
    this.sockets.delete(ws);
    if (ws.data.ctx && this.socketsByClient.get(ws.data.ctx.clientId) === ws) this.socketsByClient.delete(ws.data.ctx.clientId);
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    const ctx = ws.data.ctx;
    if (ctx) this.notify(this.closedListeners, ctx, "client-closed");
  }

  private notify(listeners: Set<(ctx: CallContext) => void>, ctx: CallContext, label: string): void {
    for (const cb of [...listeners]) {
      try {
        cb(ctx);
      } catch (error) {
        console.warn(`${label} listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private onMessage(ws: Socket, raw: string | Buffer): void {
    const message = parseJsonObject(raw);
    if (!ws.data.ctx) {
      this.authenticate(ws, message);
      return;
    }
    const call = message ? asCall(message) : null;
    if (!call) {
      console.warn("ignoring malformed client message");
      return;
    }
    void this.runCall(ws, ws.data.ctx, call);
  }

  private authenticate(ws: Socket, message: Record<string, unknown> | null): void {
    const hello = asHello(message);
    if (!hello || hello.token.length > MAX_TOKEN_LENGTH) {
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      ws.close(CLOSE_PROTOCOL_MISMATCH, "protocol mismatch");
      return;
    }
    const auth = this.options.authorize(hello.token);
    if (!auth || (auth.kind === "device" && DESKTOP_CLIENT_KINDS.has(hello.client))) {
      ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    const ctx: CallContext = { clientId: randomUUID(), client: hello.client, auth };
    ws.data.ctx = ctx;
    this.socketsByClient.set(ctx.clientId, ws);
    const welcome: ServerMessage = { t: "welcome", protocol: PROTOCOL_VERSION, serverVersion: this.options.version, clientId: ctx.clientId };
    sendRaw(ws, JSON.stringify(welcome));
    this.notify(this.acceptedListeners, ctx, "client-accepted");
  }

  private async runCall(ws: Socket, ctx: CallContext, call: CallMessage): Promise<void> {
    const { id, method, params } = call;
    try {
      const value = await this.options.router.dispatch(method, params, ctx);
      if (id !== undefined) sendRaw(ws, JSON.stringify({ t: "result", id, ok: true, value: value ?? null } satisfies ServerMessage));
    } catch (error) {
      if (id === undefined) console.warn(`fire-and-forget call '${method}' failed: ${toRpcError(error).message}`);
      else sendRaw(ws, JSON.stringify({ t: "result", id, ok: false, error: toRpcError(error) } satisfies ServerMessage));
    }
  }
}
