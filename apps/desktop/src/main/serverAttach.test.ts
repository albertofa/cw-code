import { describe, expect, it } from "bun:test";
import type { ServerReady } from "@cw-code/contracts";
import { decideServerStart, stopUrl, waitForPidExit } from "./serverAttach.js";

const ME = { installId: "install-1", version: "0.0.1-alpha.21", protocol: 3 };
const RUNNING: ServerReady = { url: "ws://127.0.0.1:51234/ws", port: 51234, pid: 4242, protocol: 3, version: "0.0.1-alpha.21", launcherId: "install-1" };

describe("decideServerStart", () => {
  const cases: Array<[string, ServerReady | null, ReturnType<typeof decideServerStart>["kind"]]> = [
    ["no live server", null, "spawn"],
    ["own server, same version and protocol", RUNNING, "attach"],
    ["own server, other version", { ...RUNNING, version: "0.0.1-alpha.20" }, "replace"],
    ["own server, other protocol", { ...RUNNING, protocol: 2 }, "replace"],
    ["another install's server", { ...RUNNING, launcherId: "install-2" }, "foreign"],
    ["server started directly (null launcher)", { ...RUNNING, launcherId: null }, "foreign"],
    ["server from before launcher ids", { url: RUNNING.url, port: RUNNING.port, pid: RUNNING.pid, protocol: 3, version: RUNNING.version }, "foreign"],
    ["empty launcher id", { ...RUNNING, launcherId: "" }, "foreign"]
  ];

  for (const [name, existing, kind] of cases) {
    it(name, () => {
      const decision = decideServerStart(existing, ME);
      expect(decision.kind).toBe(kind);
      if (decision.kind !== "spawn") expect(decision.ready).toBe(existing as ServerReady);
    });
  }
});

describe("stopUrl", () => {
  it("maps the ws endpoint to the http stop route", () => {
    expect(stopUrl(RUNNING)).toBe("http://127.0.0.1:51234/api/stop");
    expect(stopUrl({ ...RUNNING, url: "ws://[::1]:4000/ws" })).toBe("http://[::1]:4000/api/stop");
  });
});

describe("waitForPidExit", () => {
  it("resolves true once the pid is gone and false on timeout", async () => {
    let checks = 0;
    expect(await waitForPidExit(1, 1_000, () => ++checks < 3)).toBe(true);
    expect(checks).toBe(3);
    expect(await waitForPidExit(1, 150, () => true)).toBe(false);
  });
});
