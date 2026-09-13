import { writeFile } from "node:fs/promises";

const [port = "9222", output = ".impeccable/review/desktop.png", widthRaw = "1674", heightRaw = "943"] = process.argv.slice(2);
const width = Number(widthRaw);
const height = Number(heightRaw);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.title === "cw-code") ?? targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("No cw-code CDP page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function call(method, params = {}) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}

await call("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: width,
  screenHeight: height
});
await call("Page.bringToFront");
await Promise.race([
  call("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true }),
  new Promise((resolve) => setTimeout(resolve, 2000))
]);
if (process.env.CW_CDP_EXPRESSION) {
  const evaluated = await call("Runtime.evaluate", {
    expression: process.env.CW_CDP_EXPRESSION,
    awaitPromise: true,
    returnByValue: true
  });
  if (evaluated?.result?.value !== undefined) console.log(JSON.stringify(evaluated.result.value));
}
await new Promise((resolve) => setTimeout(resolve, 350));
const capture = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
await writeFile(output, Buffer.from(capture.data, "base64"));
socket.close();
process.exit(0);
