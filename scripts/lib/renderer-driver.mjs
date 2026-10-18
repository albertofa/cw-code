import { setTimeout as sleep } from "node:timers/promises";
import { formatScalar, readPublisherNames } from "../../tools/release/src/updateInfoYaml.ts";
import { parseAppUpdateYaml } from "./upgrade-builds.mjs";

const DEVTOOLS_TIMEOUT_MS = 90_000;
export const POLL_MS = 1_000;

export const RENDERER_DRIVER = `(async () => {
  const steps = [];
  const cw = window.cw;
  if (!cw || !cw.updates || !cw.shutdown) return { steps, error: "window.cw bridge is not available" };
  const summary = (result) => ({ ok: result.ok, code: result.code ?? null, message: result.message ?? null, phase: result.state.phase, availableVersion: result.state.availableVersion, downloadedVersion: result.state.downloadedVersion, error: result.state.error });
  const check = await cw.updates.check();
  steps.push({ step: "check", ...summary(check) });
  if (check.state.phase !== "available" && check.state.phase !== "ready") return { steps };
  const download = await cw.updates.download();
  steps.push({ step: "download", ...summary(download) });
  const state = await cw.updates.getState();
  if (state.phase !== "ready" || !state.downloadedVersion) return { steps };
  const prepared = await cw.shutdown.prepare({ reason: "update", stopActiveTurns: true, timeoutMs: 15000 });
  steps.push({ step: "prepare", ok: prepared.ok, code: prepared.code ?? null });
  if (!prepared.ok) return { steps };
  void cw.updates.install({ version: state.downloadedVersion, channel: state.channel, token: prepared.token });
  steps.push({ step: "install-requested", version: state.downloadedVersion, channel: state.channel });
  return { steps };
})()`;

export const RENDERER_UPDATE_STATE = `(async () => {
  const state = await window.cw.updates.getState();
  return { runningVersion: state.runningVersion, phase: state.phase, channel: state.channel, disabledReason: state.disabledReason ?? null };
})()`;

export function rewriteAppUpdateForLoopback(original, feedUrl) {
  const parsed = parseAppUpdateYaml(original);
  const publisherNames = readPublisherNames(original);
  const lines = ["provider: generic", `url: ${feedUrl}`];
  if (parsed.updaterCacheDirName) lines.push(`updaterCacheDirName: ${formatScalar(parsed.updaterCacheDirName)}`);
  if (publisherNames.length > 0) lines.push("publisherName:", ...publisherNames.map((name) => `  - ${formatScalar(name)}`));
  return { text: `${lines.join("\n")}\n`, publisherNames, cacheDirName: parsed.updaterCacheDirName ?? null, originalProvider: parsed.provider ?? null };
}

export async function devToolsPage(port, timeoutMs = DEVTOOLS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && String(target.url).startsWith("file:"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      await sleep(POLL_MS);
      continue;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`the production app did not expose its renderer on DevTools port ${port} within ${timeoutMs / 1000}s`);
}

export function evaluateInPage(webSocketUrl, expression, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      rejectPromise(new Error(`renderer evaluation did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (payload.error || payload.result?.exceptionDetails) {
        rejectPromise(new Error(JSON.stringify(payload.error ?? payload.result.exceptionDetails).slice(0, 500)));
        return;
      }
      resolvePromise(payload.result.result.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("could not talk to the renderer over DevTools"));
    });
  });
}

export async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return null;
}
