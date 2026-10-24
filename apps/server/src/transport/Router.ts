import type { ClientKind, RpcError } from "@cw-code/contracts";

export type ClientAuth = { kind: "owner" } | { kind: "device"; deviceId: string };

export interface CallContext {
  clientId: string;
  client: ClientKind;
  auth: ClientAuth;
}

export type Handler = (params: unknown, ctx: CallContext) => unknown | Promise<unknown>;

export class Router {
  private handlers = new Map<string, Handler>();

  handle(method: string, handler: Handler): void {
    if (this.handlers.has(method)) throw new Error(`method '${method}' is already registered`);
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async dispatch(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw Object.assign(new Error(`unknown method '${method}'`), { code: "unknown-method" });
    return handler(params, ctx);
  }
}

export function toRpcError(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? { message, code } : { message };
}
