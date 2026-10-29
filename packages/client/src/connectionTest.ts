import type { ConnectionTestResult, ServerEndpoint, ServerInfo } from "@cw-code/contracts";
import { INFO_PATH, isServerInfo, PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { parseServerAddress } from "@cw-code/shared/serverAddress";
import { ServerCallError, ServerClient } from "./ServerClient.js";

export const CONNECTION_TEST_TIMEOUT_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConnectionProbe {
  fetchInfo(url: string, timeoutMs: number): Promise<unknown>;
  hello(endpoint: ServerEndpoint, timeoutMs: number): Promise<void>;
}

export function infoUrl(httpUrl: string): string {
  return new URL(INFO_PATH.slice(1), httpUrl.endsWith("/") ? httpUrl : `${httpUrl}/`).href;
}

export async function fetchServerInfo(url: string, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`no answer within ${timeoutMs / 1000}s`);
    }
    throw error;
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

export async function helloAsWeb(endpoint: ServerEndpoint, timeoutMs: number): Promise<void> {
  const client = new ServerClient({ endpoint, client: "web", reconnect: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
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

export const NETWORK_PROBE: ConnectionProbe = { fetchInfo: fetchServerInfo, hello: helloAsWeb };

function unreachable(message: string, info?: ServerInfo): ConnectionTestResult {
  return { ok: false, code: "unreachable", message, ...(info ? { info } : {}) };
}

function mismatch(info: ServerInfo): ConnectionTestResult {
  return { ok: false, code: "protocol-mismatch", message: `the server runs cw-code v${info.version} (protocol ${info.protocol})`, info };
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
  if (info.protocol !== PROTOCOL_VERSION) return mismatch(info);
  const secret = token ?? address.token;
  if (!secret) return { ok: false, code: "unauthorized", message: "enter a device token for this server", info };
  try {
    await probe.hello({ url: address.wsUrl, token: secret }, timeoutMs);
  } catch (error) {
    const code = error instanceof ServerCallError ? error.code : undefined;
    if (code === "unauthorized") return { ok: false, code: "unauthorized", message: "the server rejected this device token (revoked or mistyped)", info };
    if (code === "protocol-mismatch") return mismatch(info);
    return unreachable(`could not open a session on ${address.wsUrl}: ${errorMessage(error)}`, info);
  }
  return { ok: true, info };
}
