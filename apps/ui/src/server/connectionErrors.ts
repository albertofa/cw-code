import type { ServerCallError } from "@cw-code/client";
import type { ServerInfo } from "@cw-code/contracts";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { version as uiVersion } from "../../package.json";

export type ConnectionSide = "web" | "desktop";

export interface ConnectionErrorText {
  title: string;
  message: string;
}

function desktopMismatchText(info: ServerInfo | null): string {
  const server = info ? `Server v${info.version} (protocol ${info.protocol})` : "The server";
  return `${server} and this app v${uiVersion} (protocol ${PROTOCOL_VERSION}) can't talk. Update the app or the server so both run the same version.`;
}

function mismatchText(info: ServerInfo | null, side: ConnectionSide): string {
  if (side === "desktop") return desktopMismatchText(info);
  const local = `this page is v${uiVersion} (protocol ${PROTOCOL_VERSION})`;
  if (!info) return `The server runs a different cw-code version; ${local}. Reload the page.`;
  return `The server runs cw-code v${info.version} (protocol ${info.protocol}); ${local}. Reload the page.`;
}

export function describeConnectionError(error: ServerCallError | null, info: ServerInfo | null, side: ConnectionSide): ConnectionErrorText {
  switch (error?.code) {
    case "unauthorized":
      return {
        title: "Access denied",
        message: side === "web" ? "This device token was rejected (revoked or mistyped)." : "The server rejected this connection's token (revoked or mistyped)."
      };
    case "protocol-mismatch":
      return { title: "Version mismatch", message: mismatchText(info, side) };
    case "disconnected":
      return { title: "Connection lost", message: "The connection to the cw-code server was lost." };
    default:
      return { title: "Could not connect to the cw-code server", message: error?.message || "The server did not answer." };
  }
}
