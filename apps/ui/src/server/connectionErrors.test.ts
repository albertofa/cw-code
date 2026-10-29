import { describe, expect, it } from "bun:test";
import { ServerCallError } from "@cw-code/client";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { version } from "../../package.json";
import { describeConnectionError } from "./connectionErrors.js";

const info = { app: "cw-code" as const, version: "9.9.9", protocol: 99 };

describe("describeConnectionError", () => {
  it("explains a rejected device token in a browser", () => {
    expect(describeConnectionError(new ServerCallError("server rejected the access token", "unauthorized"), null, "web")).toEqual({
      title: "Access denied",
      message: "This device token was rejected (revoked or mistyped)."
    });
  });

  it("explains a rejected token in the desktop app", () => {
    expect(describeConnectionError(new ServerCallError("x", "unauthorized"), null, "desktop").message).toBe(
      "The server rejected this connection's token (revoked or mistyped)."
    );
  });

  it("names both versions on a protocol mismatch", () => {
    const error = new ServerCallError("server protocol version mismatch", "protocol-mismatch");
    expect(describeConnectionError(error, info, "web")).toEqual({
      title: "Version mismatch",
      message: `The server runs cw-code v9.9.9 (protocol 99); this page is v${version} (protocol ${PROTOCOL_VERSION}). Reload the page.`
    });
    expect(describeConnectionError(error, info, "desktop").message).toBe(
      `Server v9.9.9 (protocol 99) and this app v${version} (protocol ${PROTOCOL_VERSION}) can't talk. Update the app or the server so both run the same version.`
    );
    expect(describeConnectionError(error, null, "desktop").message).toBe(
      `The server and this app v${version} (protocol ${PROTOCOL_VERSION}) can't talk. Update the app or the server so both run the same version.`
    );
  });

  it("still explains a mismatch when the server info is unavailable", () => {
    expect(describeConnectionError(new ServerCallError("x", "protocol-mismatch"), null, "web").message).toBe(
      `The server runs a different cw-code version; this page is v${version} (protocol ${PROTOCOL_VERSION}). Reload the page.`
    );
  });

  it("reports a lost connection", () => {
    expect(describeConnectionError(new ServerCallError("server connection lost", "disconnected"), null, "web").title).toBe("Connection lost");
  });

  it("passes other failures through with their message", () => {
    expect(describeConnectionError(new ServerCallError("could not connect to the server (close code 1006)", "connect-failed"), null, "desktop")).toEqual({
      title: "Could not connect to the cw-code server",
      message: "could not connect to the server (close code 1006)"
    });
    expect(describeConnectionError(null, null, "web")).toEqual({ title: "Could not connect to the cw-code server", message: "The server did not answer." });
  });
});
